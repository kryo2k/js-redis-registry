"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis = require("redis");
const events = require("events");
const uuid = require("uuid/v4");
const js_binary_model_1 = require("js-binary-model");
exports.MessageModel = new js_binary_model_1.BinaryModel({
    sender: js_binary_model_1.DataType.STRING,
    arguments: js_binary_model_1.DataType.JSON
});
exports.MessageEncoding = 'base64';
exports.ChannelConfigSet = 'ConfigSet';
exports.ChannelConfigClear = 'ConfigClear';
class SystemRegistry extends events.EventEmitter {
    constructor(clientConfig, keyspace = 'global') {
        super();
        this.store = {};
        this.subscriber = null;
        this.uniqId = uuid();
        this.clientConfig = clientConfig;
        this.keyspace = keyspace;
        // initialize and emit ready when so.
        this.pull(() => this.emit('ready'));
    }
    get keyConfig() {
        return 'config:' + this.keyspace;
    }
    emitError(err) {
        this.emit('error', err);
    }
    emitUpdated() {
        this.emit('updated');
    }
    emitCleared(key) {
        this.emit('cleared', key);
        this.emitUpdated();
    }
    emitSet(key, value, previousValue) {
        this.emit('set', key, value, previousValue);
        this.emitUpdated();
    }
    getClient() {
        return new redis.RedisClient(this.clientConfig);
    }
    publish(cli, channel, ...args) {
        cli.publish(channel, exports.MessageModel.encode({
            sender: this.uniqId,
            arguments: args
        }).toString(exports.MessageEncoding));
    }
    applyEncodedKeyValue(key, value) {
        try {
            this.store[key] = JSON.parse(value);
        }
        catch (e) {
        }
    }
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
    }
    keySpaceChannel(channel) {
        return `${channel}:${this.keyspace}`;
    }
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
    get(key, defaultValue = undefined) {
        if (!this.store.hasOwnProperty(key))
            return defaultValue;
        return this.store[key];
    }
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
    stopMonitor(cb) {
        if (!this.subscriber)
            return this;
        this.subscriber.quit(cb);
        this.subscriber = null;
        return this;
    }
}
exports.SystemRegistry = SystemRegistry;
;
exports.default = SystemRegistry;
