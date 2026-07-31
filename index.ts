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
 * failed", and {@link TagCache.invalidate} resolves once the work is ISSUED, not
 * once the keys are gone.
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
     * Collects every key held by the given tags, deletes those keys, and then
     * removes them from all other tag sets so no tag is left pointing at a key
     * that no longer exists.
     *
     * Two properties worth knowing, because neither is obvious from the
     * signature:
     *
     * - **It resolves before the work is confirmed.** The deletion is dispatched
     *   as a `MULTI` whose result is not awaited — a failure is logged, not
     *   returned. So a `true` result means "the invalidation was issued", not
     *   "the keys are gone". Do not use it to order a subsequent read.
     * - **The cleanup pass scans every tag**, not just the ones passed in, since
     *   a key may be held by tags other than those being invalidated. Cost
     *   therefore grows with the total number of tags in the keyspace rather
     *   than with the size of `tags`.
     *
     * @param tags - one or more tags whose data should be dropped
     * @returns `true` if the invalidation was issued, including the case where
     *          the tags held no keys at all; `false` only if collecting the keys
     *          failed, which is logged rather than thrown
     * @throws TypeError when there is no redis connection — see
     *         {@link REDIS_INIT_ERROR}
     */
    public async invalidate(...tags: string[]): Promise<boolean> {
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            const tagKeys = tags.map(tag => this.key(`tag:${tag}`));
            const keys: string[] = [
                ...new Set(
                    ([] as string[]).concat(
                        ...((await Promise.all(
                            tagKeys.map(tag => {
                                const redis = this.redis;

                                if (!redis) {
                                    throw new TypeError(REDIS_INIT_ERROR);
                                }

                                return new Promise(resolve => {
                                    redis.smembers(tag, (_, reply) =>
                                        resolve(reply),
                                    );
                                });
                            }),
                        )) as unknown as string[]),
                    ),
                ),
            ];

            if (!keys.length) {
                // nothing to do, no keys found
                return true;
            }

            const multi: ChainableCommander = this.redis.multi();
            let cursor = '0';

            multi.del(...keys);

            do {
                const reply = await this.redis.scan(
                    cursor,
                    'MATCH',
                    this.key('tag:*'),
                    'COUNT',
                    '1000',
                );

                cursor = reply[0];

                for (const tag of reply[1]) {
                    multi.srem(tag, ...keys);
                }
            } while (cursor !== '0');

            multi
                .exec()
                .catch(err =>
                    this.logger.warn(
                        'TagCache: invalidate error:',
                        (err as Error).stack,
                    ),
                );

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
