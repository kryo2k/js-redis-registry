"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis = require("redis");
const events = require("events");
const uuid = require("uuid/v4");
const js_binary_model_1 = require("js-binary-model");
/**
* Message object to contain pubsub encoded messages.
*/
exports.MessageModel = new js_binary_model_1.BinaryModel({
    sender: js_binary_model_1.DataType.STRING,
    arguments: js_binary_model_1.DataType.JSON
});
/**
* Encoding to use in messages
*/
exports.MessageEncoding = 'base64';
/**
* Redis pub channel for config:set action
*/
exports.ChannelConfigSet = 'ConfigSet';
/**
* Redis pub channel for config:clear action
*/
exports.ChannelConfigClear = 'ConfigClear';
/**
* Main redis registry object.
*/
class Registry extends events.EventEmitter {
    /**
    * Construct registry class.
    */
    constructor(clientConfig, keyspace = 'global') {
        super();
        /**
        * Local key:value store to memoize state of configuration.
        */
        this.store = {};
        // Internal subscriber redis client, populated once monitoring is started.
        this.subscriber = null;
        // Unique id for this instance. Used to determine if pubsub messages are received by same sender.
        this.uniqId = uuid();
        this.clientConfig = clientConfig;
        this.keyspace = keyspace;
        // initialize and emit ready when so.
        this.pull(() => this.emit('ready'));
    }
    // key being used for configuration
    get keyConfig() {
        return 'config:' + this.keyspace;
    }
    // shortcut to emit error events
    emitError(err) {
        this.emit('error', err);
    }
    // shortcut to emit update events
    emitUpdated() {
        this.emit('updated');
    }
    // shortcut to emit key clear events
    emitCleared(key) {
        this.emit('cleared', key);
        this.emitUpdated();
    }
    // shortcut to emit key set events
    emitSet(key, value, previousValue) {
        this.emit('set', key, value, previousValue);
        this.emitUpdated();
    }
    // gets a new redis client instance
    getClient() {
        let client = new redis.RedisClient(this.clientConfig);
        client.on('error', (err) => this.emitError(err)); // relay redis errors as our own errors
        // client.on('connect', () => this.emit('redis_connect', client, this.clientConfig));
        // client.on('end', () => this.emit('redis_end', client, this.clientConfig));
        return client;
    }
    // publish a message using a client instance.
    publish(cli, channel, ...args) {
        cli.publish(channel, exports.MessageModel.encode({
            sender: this.uniqId,
            arguments: args
        }).toString(exports.MessageEncoding));
    }
    // applies an encoded value to local keystore
    applyEncodedKeyValue(key, value) {
        try {
            this.store[key] = JSON.parse(value);
        }
        catch (e) {
        }
    }
    // returns keyspaced channel name
    keySpaceChannel(channel) {
        return `${channel}:${this.keyspace}`;
    }
    // handles messages from pubsub subscriptions
    onSubscriberMessage(channel, message) {
        const dMessage = exports.MessageModel.decode(Buffer.from(message, exports.MessageEncoding)), dSender = dMessage.sender, dArgs = dMessage.arguments;
        if (dSender === this.uniqId)
            return; // ignore self published messages
        let keyName = dArgs[0];
        switch (channel) {
            case this.keySpaceChannel(exports.ChannelConfigSet):
                let newValue = dArgs[1], // new value
                prevRValue = dArgs[2], // previous remote value
                prevLValue = this.store[keyName]; // previous local value
                this.store[keyName] = newValue;
                this.emitSet(keyName, newValue, prevLValue);
                break;
            case this.keySpaceChannel(exports.ChannelConfigClear):
                delete this.store[keyName];
                this.emitCleared(keyName);
                break;
        }
    }
    /**
    * Pull latest settings in redis key for current namespace. Useful if
    * namespace and/or redis configuration changes.
    */
    pull(onSuccess) {
        this.store = {}; // reset the store
        let client = this.getClient();
        client.hgetall(this.keyConfig, (err, hash) => {
            client.quit(); // no longer needed
            if (err)
                return this.emitError(err);
            // update store with decoded keys values
            if (hash)
                Object.keys(hash).forEach(key => this.applyEncodedKeyValue(key, hash[key]));
            // signal local update
            this.emitUpdated();
            if (onSuccess)
                onSuccess();
        });
        return this;
    }
    /**
    * Watches a key for changes. Callback is fired whenever key is changed. Returns
    * a function used to clean up and kill the listener.
    */
    watch(key, onModified) {
        let ended = false;
        const eventNameSet = 'set', eventNameClear = 'clear', listenerSet = (_key, value, prevVal) => {
            if (ended)
                return;
            if (key === _key)
                onModified(value);
        }, listenerClear = (_key) => {
            if (ended)
                return;
            if (key === _key)
                onModified(undefined);
        };
        this.on(eventNameSet, listenerSet);
        this.on(eventNameClear, listenerClear);
        return () => {
            ended = true;
            this.removeListener(eventNameSet, listenerSet);
            this.removeListener(eventNameClear, listenerClear);
        };
    }
    /**
    * Gets the current value of a key.
    */
    get(key, defaultValue = undefined) {
        if (!this.store.hasOwnProperty(key))
            return defaultValue;
        return this.store[key];
    }
    /**
    * Sets the current value of a key. Propagates this change to all syndicated registries.
    */
    set(key, value) {
        let previous = this.store[key];
        if (previous === value)
            return this;
        this.store[key] = value; // set local version first
        let client = this.getClient();
        // persist this setting in the background
        client.hset(this.keyConfig, key, JSON.stringify(value), (err, n) => {
            this.publish(client, this.keySpaceChannel(exports.ChannelConfigSet), key, value, previous); // publish to sync other nodes
            client.quit(); // no longer needed
            if (err)
                return this.emitError(err);
            // signal local update
            this.emitSet(key, value, previous);
        });
        return this;
    }
    /**
    * Clears the setting on a key. Propagates this change to all syndicated registries.
    */
    clear(key) {
        if (this.store.hasOwnProperty(key))
            delete this.store[key];
        let client = this.getClient();
        // persist this setting in the background
        client.hdel(this.keyConfig, key, (err, n) => {
            this.publish(client, this.keySpaceChannel(exports.ChannelConfigClear), key); // publish to sync other nodes
            client.quit(); // no longer needed
            if (err)
                return this.emitError(err);
            // signal local update
            this.emitCleared(key);
        });
        return this;
    }
    /**
    * Starts the monitoring service (via pubsub).
    */
    startMonitor() {
        if (this.subscriber)
            return this;
        let subscriber = this.subscriber = redis.createClient(this.clientConfig);
        subscriber.on('message', this.onSubscriberMessage.bind(this));
        // update internal store if these channels are used
        subscriber.subscribe(this.keySpaceChannel(exports.ChannelConfigSet));
        subscriber.subscribe(this.keySpaceChannel(exports.ChannelConfigClear));
        return this;
    }
    /**
    * Ends the monitoring service.
    */
    stopMonitor(cb) {
        if (!this.subscriber)
            return this;
        this.subscriber.quit(cb);
        this.subscriber = null;
        return this;
    }
}
exports.Registry = Registry;
;
exports.default = Registry;
