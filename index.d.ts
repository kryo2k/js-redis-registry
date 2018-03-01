/// <reference types="node" />
import * as redis from 'redis';
import * as events from 'events';
import { BinaryModel } from 'js-binary-model';
/**
* Message object to contain pubsub encoded messages.
*/
export declare const MessageModel: BinaryModel;
/**
* Encoding to use in messages
*/
export declare const MessageEncoding = "base64";
/**
* Redis pub channel for config:set action
*/
export declare const ChannelConfigSet = "ConfigSet";
/**
* Redis pub channel for config:clear action
*/
export declare const ChannelConfigClear = "ConfigClear";
/**
* Main redis registry object.
*/
export declare class Registry extends events.EventEmitter {
    /**
    * Configuration to use for connecting to redis.
    */
    clientConfig: redis.ClientOpts;
    /**
    * Key namespace to use for this Registry object.
    */
    keyspace: string;
    /**
    * Local key:value store to memoize state of configuration.
    */
    store: {
        [key: string]: any;
    };
    private subscriber;
    private uniqId;
    /**
    * Construct registry class.
    */
    constructor(clientConfig: redis.ClientOpts, keyspace?: string);
    protected readonly keyConfig: string;
    protected emitError(err: Error): void;
    protected emitUpdated(): void;
    protected emitCleared(key: string): void;
    protected emitSet(key: string, value: any, previousValue: any): void;
    protected getClient(): redis.RedisClient;
    protected publish(cli: redis.RedisClient, channel: string, ...args: any[]): void;
    protected applyEncodedKeyValue(key: string, value: string): void;
    protected keySpaceChannel(channel: string): string;
    protected onSubscriberMessage(channel: string, message: string): void;
    /**
    * Pull latest settings in redis key for current namespace. Useful if
    * namespace and/or redis configuration changes.
    */
    pull(onSuccess?: Function): Registry;
    /**
    * Watches a key for changes. Callback is fired whenever key is changed. Returns
    * a function used to clean up and kill the listener.
    */
    watch(key: string, onModified: (newValue: any) => void): Function;
    /**
    * Gets the current value of a key.
    */
    get(key: string, defaultValue?: any): any;
    /**
    * Sets the current value of a key. Propagates this change to all syndicated registries.
    */
    set(key: string, value: any): Registry;
    /**
    * Clears the setting on a key. Propagates this change to all syndicated registries.
    */
    clear(key: string): Registry;
    /**
    * Starts the monitoring service (via pubsub).
    */
    startMonitor(): Registry;
    /**
    * Ends the monitoring service.
    */
    stopMonitor(cb?: redis.Callback<'OK'>): Registry;
}
export default Registry;
