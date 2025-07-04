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
import { ILogger, IRedisClient, RedisCache } from '@imqueue/rpc';
import { Multi } from 'redis';

export const REDIS_INIT_ERROR = 'Redis engine is not initialized!';

/**
 * Empty function used to ignore promises, for cases, when we do not care
 * about results and just want to execute some routines in background
 */
function ignore() { /* do nothing */ }

// noinspection JSUnusedGlobalSymbols
export class TagCache {

    public logger: ILogger;
    public redis?: IRedisClient;
    public readonly key: (key: string) => string;

    // noinspection TypeScriptUnresolvedVariable,JSUnusedGlobalSymbols
    /**
     * @constructor
     * @param {RedisCache} cache
     */
    constructor(public cache?: RedisCache) {
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
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

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
            this.logger.warn('TagCache: get error:', err.stack);

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
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            const multi: Multi = this.redis.multi();
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
            this.logger.warn('TagCache: set error:', err.stack);

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
        if (!this.redis) {
            throw new TypeError(REDIS_INIT_ERROR);
        }

        try {
            const tagKeys = tags.map(tag => this.key(`tag:${tag}`));
            const keys: string[] = [...new Set(([] as string[]).concat(
                ...await Promise.all(
                    tagKeys.map(tag => {
                        const redis = this.redis;

                        if (!redis) {
                            throw new TypeError(REDIS_INIT_ERROR);
                        }

                        return new Promise(resolve => {
                            redis.smembers(
                                tag,
                                ((err, reply) => resolve(reply)),
                            );
                        });
                    }),
                ) as unknown as string[]
            ))];

            if (!keys.length) {
                // nothing to do, no keys found
                return true;
            }

            const multi: Multi = this.redis.multi();
            let cursor = '0';

            multi.del(...keys);

            do {
                const reply: any[] = (await this.redis.scan(
                    cursor,
                    'MATCH',
                    this.key('tag:*'),
                    'COUNT',
                    '1000',
                )) as unknown as any[];

                cursor = reply[0];

                for (const tag of reply[1]) {
                    multi.srem(tag, ...keys);
                }
            } while (cursor !== '0');

            multi.exec();

            return true;
        } catch (err) {
            this.logger.warn('TagCache: invalidate error:', err.stack);

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
