/*!
 * @imqueue/tag-cache - Tagged Cache implementation over redis for @imqueue
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
/**
 * Tagged cache over Redis: every value is stored with a set of tags, and
 * invalidating a tag drops everything stored under it.
 *
 * Start from {@link TagCache}, built on an initialised `RedisCache` from
 * `@imqueue/rpc`.
 *
 * @remarks
 * This exists for the case plain key-based caching cannot express: one cached
 * value that several unrelated events should invalidate. Tagging a result with
 * every entity it derives from means any one of those entities changing drops
 * it, whatever key it was stored under.
 *
 * Reads and writes never throw on a Redis failure — they log and report it in
 * the return value, so an outage degrades to cache misses. Note that
 * {@link TagCache.get} returning `null` therefore means "not cached OR lookup
 * failed". {@link TagCache.invalidate} resolves once the tagged keys are gone,
 * working through a tag in bounded batches however large it is.
 *
 * @example
 * ```typescript
 * import { RedisCache } from '@imqueue/rpc';
 * import { TagCache } from '@imqueue/tag-cache';
 *
 * const cache = new TagCache(await new RedisCache().init({ prefix: 'app' }));
 *
 * await cache.set('user:1:invoices', invoices, ['user:1', 'invoices'], 60000);
 * await cache.invalidate('user:1'); // drops it, and anything else tagged user:1
 * ```
 *
 * @packageDocumentation
 */
import { type ILogger, RedisCache } from '@imqueue/rpc';
import { type ChainableCommander, type Redis } from 'ioredis';

/**
 * Message of the `TypeError` thrown by every cache operation when no redis
 * connection is available — either `RedisCache.init()` was never awaited, or
 * {@link TagCache.destroy} has already been called on this instance.
 */
export const REDIS_INIT_ERROR = 'Redis engine is not initialized!';

/**
 * How many members of a tag set {@link TagCache.invalidate} reads and deletes
 * per round trip. A `COUNT` hint to `SSCAN`, so a batch may come back somewhat
 * larger or smaller.
 */
export const INVALIDATE_BATCH = 1000;

/**
 * Tagged cache over redis: values are stored under their own keys, and each key
 * is additionally added to a redis set per tag. Invalidating a tag then drops
 * every value that was stored with it, which is what plain key-based caching
 * cannot express — one write can be invalidated by any of several unrelated
 * events.
 *
 * The typical use is caching a computed result that depends on several entities
 * and dropping it when any one of them changes:
 *
 * ```typescript
 * import { RedisCache } from '@imqueue/rpc';
 * import { TagCache } from '@imqueue/tag-cache';
 *
 * const cache = new TagCache(await new RedisCache().init({ prefix: 'app' }));
 *
 * await cache.set('user:1:invoices', invoices, ['user:1', 'invoices'], 60000);
 *
 * // later, when user 1 changes — drops the entry above and anything else
 * // tagged 'user:1', whatever key it was stored under
 * await cache.invalidate('user:1');
 * ```
 *
 * Two things to know before relying on it. Read and write operations do NOT
 * throw on a redis failure: they log a warning and report the failure in their
 * return value, so a cache outage degrades to cache misses instead of taking
 * the caller down. And the underlying redis connection is shared and owned by
 * `RedisCache`, so {@link TagCache.destroy} tears it down for every instance —
 * see that method.
 */
export class TagCache {
    /**
     * Logger inherited from the underlying `RedisCache`. Every swallowed redis
     * error is reported through it at warning level.
     */
    public logger: ILogger;

    /**
     * Shared `ioredis` connection taken from `RedisCache` at construction
     * time. Absent until `RedisCache.init()` has been awaited, and deleted
     * again by {@link TagCache.destroy} — while it is absent every operation
     * throws a `TypeError` carrying {@link REDIS_INIT_ERROR}.
     */
    public redis?: Redis;

    /**
     * Maps a caller-supplied key onto the fully-qualified redis key, applying
     * the prefix the underlying `RedisCache` was initialised with. Bound to
     * that cache, so it is safe to pass around detached.
     */
    public readonly key: (key: string) => string;

    /**
     * @param cache - initialised `RedisCache` to borrow the connection, key
     *                prefix and logger from. `RedisCache.init()` must already
     *                have been awaited: this reads the connection immediately
     *                rather than lazily, so an uninitialised cache leaves every
     *                operation throwing {@link REDIS_INIT_ERROR}.
     */
    constructor(
        /**
         * The `RedisCache` this instance borrows its connection, key prefix and
         * logger from. Deleted by {@link TagCache.destroy}. Documented here
         * rather than above the constructor because it is a parameter property,
         * and that is the only place a doc comment reaches the emitted
         * declaration.
         */
        public cache?: RedisCache,
    ) {
        this.logger = (this.cache as any).logger;
        this.redis = (RedisCache as any).redis;
        this.key = (this.cache as any).key.bind(this.cache);
    }

    /**
     * Returns data stored under given keys. If a single key provided
     * returns a single result, otherwise it will return an array of results
     * associated with the keys
     *
     * Values are JSON-decoded on the way out, so what comes back is what was
     * passed to {@link TagCache.set}, not a string.
     *
     * A redis failure is not thrown: it is logged as a warning and reported as
     * `null`. That makes `null` ambiguous between "not cached" and "lookup
     * failed", which is the right trade for a cache but means it must never be
     * treated as proof that a value is absent.
     *
     * @param keys - one or more unprefixed keys to read
     * @returns the decoded value for a single key, an array of values in the
     *          order the keys were given for several, or `null` — per element
     *          for a miss, or as the whole result on error
     * @throws TypeError when there is no redis connection — see
     *         {@link REDIS_INIT_ERROR}
     */
    public async get(...keys: string[]): Promise<any | null | (any | null)[]> {
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            if (keys.length === 1) {
                const value = await this.redis.get(this.key(keys[0]));

                return value ? JSON.parse(value) : null;
            }

            const values = await this.redis.mget(
                keys.map(key => this.key(key)),
            );

            return values.map(value => (value ? JSON.parse(value) : null));
        } catch (err) {
            this.logger.warn('TagCache: get error:', (err as Error).stack);

            return null;
        }
    }

    /**
     * Stores given value under a given key, tagging it with the given tags
     *
     * The value is JSON-encoded, and the key is added to one redis set per tag
     * so {@link TagCache.invalidate} can find it later. Everything happens in a
     * single `MULTI`, so a value is never visible without its tag membership.
     *
     * When `ttl` is given it is applied to the value AND refreshed on each tag
     * set, so tag sets do not outlive the entries they track. Without it,
     * nothing expires and the entry lives until it is invalidated.
     *
     * @param key - unprefixed key to store the value under
     * @param value - data to store; must be JSON-serialisable
     * @param tags - tags to mark the value with; any one of them can later
     *               invalidate it. An empty array stores the value with no tag,
     *               which makes it unreachable by {@link TagCache.invalidate}.
     * @param ttl - optional time to live, in MILLISECONDS
     * @returns `true` once the write is committed, `false` if redis rejected it
     *          — the error is logged rather than thrown
     * @throws TypeError when there is no redis connection — see
     *         {@link REDIS_INIT_ERROR}
     */
    public async set<_T = any>(
        key: string,
        value: any,
        tags: string[],
        ttl?: number,
    ): Promise<boolean> {
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            const multi: ChainableCommander = this.redis.multi();
            const setKey = this.key(key);

            for (const tag of tags) {
                const tagKey = this.key(`tag:${tag}`);

                multi.sadd(tagKey, setKey);

                if (ttl) {
                    multi.pexpire(tagKey, ttl);
                }
            }

            if (ttl) {
                multi.set(setKey, JSON.stringify(value), 'PX', ttl);
            } else {
                multi.set(setKey, JSON.stringify(value));
            }

            await multi.exec();

            return true;
        } catch (err) {
            this.logger.warn('TagCache: set error:', (err as Error).stack);

            return false;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Invalidates data under given tags
     *
     * Walks each given tag's set in batches of {@link INVALIDATE_BATCH}
     * members, deleting those keys and removing them from that tag, one
     * awaited `MULTI` per batch. Memory and command size are bounded by the
     * batch, whatever the size of the tag or of the keyspace.
     *
     * Three properties worth knowing, because none is obvious from the
     * signature:
     *
     * - **It resolves once the keys are gone.** Every batch is awaited, so a
     *   `true` result means the tagged values have been deleted.
     * - **Other tags are not scrubbed.** A deleted key may still be a member of
     *   a tag that was not invalidated. That is harmless — invalidating that tag
     *   later deletes a key that no longer exists, and a tag set given a ttl
     *   expires with it. Scrubbing every tag here costs tags x keys, which is
     *   what took a service's heap from 564MB to 15GB on one invalidation of a
     *   tag holding 15,000 keys in a keyspace of 3,000 tags.
     * - **A value cached during the invalidation stays tagged.** Only the
     *   members that were scanned are removed from the tag, so a later
     *   invalidation still reaches anything added meanwhile.
     *
     * @param tags - one or more tags whose data should be dropped
     * @returns `true` once every tagged key is deleted, including the case where
     *          the tags held no keys at all; `false` if redis failed part-way,
     *          which is logged rather than thrown
     * @throws TypeError when there is no redis connection — see
     *         {@link REDIS_INIT_ERROR}
     */
    public async invalidate(...tags: string[]): Promise<boolean> {
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            for (const tag of new Set(tags)) {
                await this.drop(this.key(`tag:${tag}`));
            }

            return true;
        } catch (err) {
            this.logger.warn(
                'TagCache: invalidate error:',
                (err as Error).stack,
            );

            return false;
        }
    }

    /**
     * Deletes every key held by one tag set, a batch at a time.
     *
     * @param tagKey - fully-qualified key of the tag set
     */
    private async drop(tagKey: string): Promise<void> {
        let cursor = '0';

        do {
            const redis = this.redis;

            if (!redis) {
                throw new TypeError(REDIS_INIT_ERROR);
            }

            const [next, keys] = await redis.sscan(
                tagKey,
                cursor,
                'COUNT',
                INVALIDATE_BATCH,
            );

            cursor = next;

            if (keys.length) {
                // exec() resolves with per-command errors instead of rejecting
                const failed = (
                    await redis
                        .multi()
                        .del(...keys)
                        .srem(tagKey, ...keys)
                        .exec()
                )?.find(([err]) => err);

                if (failed) {
                    throw failed[0];
                }
            }
        } while (cursor !== '0');
    }

    /**
     * Destroys this cache instance
     *
     * Note the connection is owned by `RedisCache` and shared, so this closes it
     * for **every** consumer, not just this instance — including other
     * `TagCache` objects built from the same cache. Treat it as application
     * shutdown rather than as releasing one instance.
     *
     * Afterwards this instance keeps no redis reference, so every operation on
     * it throws a `TypeError` carrying {@link REDIS_INIT_ERROR}.
     *
     * @returns once the shared redis connection has been closed
     */
    public async destroy(): Promise<void> {
        await RedisCache.destroy();

        delete this.redis;
        delete this.cache;
    }
}
