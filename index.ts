/*!
 * @imqueue/tag-cache - Tagged Cache implementation over redis for @imqueue
 *
 * Copyright (c) 2019, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import { ILogger, IRedisClient, RedisCache } from '@imqueue/rpc';

/**
 * Empty function used to ignore promises, for cases, when we do not care
 * about results and just want to execute some routines in background
 */
function ignore() { /* do nothing */ }

// noinspection JSUnusedGlobalSymbols
export class TagCache {

    public logger: ILogger;
    public redis: IRedisClient;
    public readonly key: (key: string) => string;

    // noinspection TypeScriptUnresolvedVariable,JSUnusedGlobalSymbols
    /**
     * @constructor
     * @param {RedisCache} cache
     */
    constructor(public cache: RedisCache) {
        this.logger = (this.cache as any).logger;
        this.redis = (RedisCache as any).redis;
        this.key = (this.cache as any).key.bind(this.cache);
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Returns data stored under given keys. If a single key provided will
     * return single result, otherwise will return an array of results
     * associated with the keys
     *
     * @param {string[]} keys
     * @return Promise<any | null | Array<any | null>>
     */
    public async get(
        ...keys: string[]
    ): Promise<any | null | (any | null)[]> {
        try {
            if (keys.length === 1) {
                const value: string = await this.redis.get(
                    this.key(keys[0]),
                ) as any as string;

                return value ? JSON.parse(value) : null;
            }

            return (await this.redis.mget(
                keys.map(key => this.key(key)),
            ) as any as string[]).map((value: string) =>
                value ? JSON.parse(value) : null
            );
        } catch (err) {
            this.logger.warn('Cache get error:', err.stack);

            return null;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Stores given value under given kay, tagging it with the given tags
     *
     * @param {string} key - name of the key to store data under
     * @param {any} value - data to store in cache
     * @param {string[]} tags - tag strings to mark data with
     * @param {number} [ttl] - TTL in milliseconds
     */
    public async set(
        key: string,
        value: any,
        tags: string[],
        ttl?: number,
    ): Promise<boolean> {
        try {
            const multi = this.redis.multi();
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
            this.logger.warn('Cache set error:', err.stack);

            return false;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Invalidates data under given tags
     *
     * @param {string[]} tags
     * @return {Promise<boolean>}
     */
    public async invalidate(...tags: string[]): Promise<boolean> {
        try {
            const tagKeys = tags.map(tag => this.key(`tag:${tag}`));
            const keys: string[] = (await Promise.all(
                tagKeys.map(tag => this.redis.smembers(tag)),
            ) || []) as unknown as string[];

            if (!keys.length) {
                // nothing to do, no keys found
                return true;
            }

            const multi = this.redis.multi();

            for (const key of keys) {
                // noinspection ES6MissingAwait
                multi.del(key);

                // remove key from tags
                for (const tag of tagKeys) {
                    multi.srem(tag, key);
                }
            }

            await multi.exec();

            return true;
        } catch (err) {
            this.logger.warn('Cache invalidate error:', err.stack);

            return false;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Destroys this cache instance
     */
    public async destroy(): Promise<void> {
        await RedisCache.destroy();

        delete this.redis;
        delete this.cache;
    }
}
