/// <reference types="node" />
import * as redis from 'redis';
import * as events from 'events';
import { BinaryModel } from 'js-binary-model';
export declare const MessageModel: BinaryModel;
export declare const MessageEncoding = "base64";
export declare const ChannelConfigSet = "ConfigSet";
export declare const ChannelConfigClear = "ConfigClear";
export declare class SystemRegistry extends events.EventEmitter {
    clientConfig: redis.ClientOpts;
    keyspace: string;
    store: {
        [key: string]: any;
    };
    private subscriber;
    private uniqId;
    constructor(clientConfig: redis.ClientOpts, keyspace?: string);
    readonly keyConfig: string;
    protected emitError(err: Error): void;
    protected emitUpdated(): void;
    protected emitCleared(key: string): void;
    protected emitSet(key: string, value: any, previousValue: any): void;
    protected getClient(): redis.RedisClient;
    protected publish(cli: redis.RedisClient, channel: string, ...args: any[]): void;
    protected applyEncodedKeyValue(key: string, value: string): void;
    protected pull(onSuccess?: Function): void;
    protected keySpaceChannel(channel: string): string;
    protected onSubscriberMessage(channel: string, message: string): void;
    watch(key: string, onModified: (newValue: any) => void): Function;
    get(key: string, defaultValue?: any): any;
    set(key: string, value: any): SystemRegistry;
    clear(key: string): SystemRegistry;
    startMonitor(): SystemRegistry;
    stopMonitor(cb?: redis.Callback<'OK'>): SystemRegistry;
}
export default SystemRegistry;
