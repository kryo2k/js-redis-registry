import * as redis from 'redis';
import * as events from 'events';
import * as uuid from 'uuid/v4';
import { BinaryModel, DataType } from 'js-binary-model';

/**
* Message object to contain pubsub encoded messages.
*/
export const MessageModel = new BinaryModel({
  sender: DataType.STRING,
  arguments: DataType.JSON
});

/**
* Encoding to use in messages
*/
export const MessageEncoding    = 'base64';

/**
* Redis pub channel for config:set action
*/
export const ChannelConfigSet   = 'ConfigSet';

/**
* Redis pub channel for config:clear action
*/
export const ChannelConfigClear = 'ConfigClear';

/**
* Main redis registry object.
*/
export class Registry extends events.EventEmitter {

  /**
  * Configuration to use for connecting to redis.
  */
  clientConfig : redis.ClientOpts;

  /**
  * Key namespace to use for this Registry object.
  */
  keyspace : string;

  /**
  * Local key:value store to memoize state of configuration.
  */
  store : { [key: string] : any } = {};

  // Internal subscriber redis client, populated once monitoring is started.
  private subscriber : redis.RedisClient | null = null;

  // Unique id for this instance. Used to determine if pubsub messages are received by same sender.
  private uniqId : string = uuid();

  /**
  * Construct registry class.
  */
  constructor (clientConfig : redis.ClientOpts, keyspace: string = 'global') {
    super();

    this.clientConfig = clientConfig;
    this.keyspace = keyspace;

    // initialize and emit ready when so.
    this.pull(() => this.emit('ready'));
  }

  // key being used for configuration
  protected get keyConfig () : string {
    return 'config:' + this.keyspace;
  }

  // shortcut to emit error events
  protected emitError(err: Error) : void {
    this.emit('error', err);
  }

  // shortcut to emit update events
  protected emitUpdated() : void {
    this.emit('updated');
  }

  // shortcut to emit key clear events
  protected emitCleared(key: string) : void {
    this.emit('cleared', key);
    this.emitUpdated();
  }

  // shortcut to emit key set events
  protected emitSet(key: string, value: any, previousValue: any) : void {
    this.emit('set', key, value, previousValue);
    this.emitUpdated();
  }

  // gets a new redis client instance
  protected getClient () : redis.RedisClient {
    let client = new redis.RedisClient(this.clientConfig);
    client.on('error', (err: Error) => this.emitError(err)); // relay redis errors as our own errors
    // client.on('connect', () => this.emit('redis_connect', client, this.clientConfig));
    // client.on('end', () => this.emit('redis_end', client, this.clientConfig));
    return client;
  }

  // publish a message using a client instance.
  protected publish(cli : redis.RedisClient, channel: string, ... args: any[]) : void {
    cli.publish(channel, MessageModel.encode({
      sender: this.uniqId,
      arguments: args
    }).toString(MessageEncoding));
  }

  // applies an encoded value to local keystore
  protected applyEncodedKeyValue(key: string, value: string) : void {
    try { // decode all stored values
      this.store[key] = JSON.parse(value);
    }
    catch(e) {
    }
  }

  // returns keyspaced channel name
  protected keySpaceChannel(channel : string) : string {
    return `${channel}:${this.keyspace}`;
  }

  // handles messages from pubsub subscriptions
  protected onSubscriberMessage(channel: string, message: string) : void {

    const
    dMessage = MessageModel.decode(Buffer.from(message, MessageEncoding)),
    dSender  = dMessage.sender as string,
    dArgs    = dMessage.arguments as any[];

    if(dSender === this.uniqId)
      return; // ignore self published messages

    let
    keyName = dArgs[0] as string;

    switch(channel) {
      case this.keySpaceChannel(ChannelConfigSet):

      let
      newValue   = dArgs[1] as any, // new value
      prevRValue = dArgs[2] as any, // previous remote value
      prevLValue = this.store[keyName]; // previous local value

      this.store[keyName] = newValue;
      this.emitSet(keyName, newValue, prevLValue);
      break;

      case this.keySpaceChannel(ChannelConfigClear):
      delete this.store[keyName];
      this.emitCleared(keyName);
      break;
    }
  }

  /**
  * Pull latest settings in redis key for current namespace. Useful if
  * namespace and/or redis configuration changes.
  */
  pull (onSuccess?: Function) : Registry {

    this.store = {}; // reset the store

    let client = this.getClient();
    client.hgetall(this.keyConfig, (err: Error|null, hash: { [key: string] : string } | null) => {
      client.quit(); // no longer needed

      if(err) return this.emitError(err);

      // update store with decoded keys values
      if(hash)
        Object.keys(hash).forEach(key => this.applyEncodedKeyValue(key, hash[key]));

      // signal local update
      this.emitUpdated();

      if(onSuccess) onSuccess();
    });

    return this;
  }

  /**
  * Watches a key for changes. Callback is fired whenever key is changed. Returns
  * a function used to clean up and kill the listener.
  */
  watch (key : string, onModified: (newValue : any) => void) : Function {
    let
    ended = false;

    const
    eventNameSet   = 'set',
    eventNameClear = 'clear',
    listenerSet = (_key : string, value: any, prevVal : any) => {
      if(ended) return;
      if(key === _key) onModified(value);
    },
    listenerClear = (_key : string) => {
      if(ended) return;
      if(key === _key) onModified(undefined);
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
  get (key: string, defaultValue: any = undefined) : any {

    if(!this.store.hasOwnProperty(key))
      return defaultValue;

    return this.store[key];
  }

  /**
  * Sets the current value of a key. Propagates this change to all syndicated registries.
  */
  set (key: string, value : any) : Registry {

    let previous = this.store[key];

    if(previous === value) // no change
      return this;

    this.store[key] = value; // set local version first

    let client = this.getClient();

    // persist this setting in the background
    client.hset(this.keyConfig, key, JSON.stringify(value), (err: Error|null, n: number) => {
      this.publish(client, this.keySpaceChannel(ChannelConfigSet), key, value, previous); // publish to sync other nodes
      client.quit(); // no longer needed

      if(err) return this.emitError(err);

      // signal local update
      this.emitSet(key, value, previous);
    });

    return this;
  }

  /**
  * Clears the setting on a key. Propagates this change to all syndicated registries.
  */
  clear (key: string) : Registry {

    if(this.store.hasOwnProperty(key)) // unset if exists
      delete this.store[key];

    let client = this.getClient();

    // persist this setting in the background
    client.hdel(this.keyConfig, key, (err: Error|null, n: number) => {
      this.publish(client, this.keySpaceChannel(ChannelConfigClear), key); // publish to sync other nodes
      client.quit(); // no longer needed

      if(err) return this.emitError(err);

      // signal local update
      this.emitCleared(key);
    });

    return this;
  }

  /**
  * Starts the monitoring service (via pubsub).
  */
  startMonitor() : Registry {

    if(this.subscriber) // already has an active subscriber client
      return this;

    let subscriber = this.subscriber = redis.createClient(this.clientConfig);

    subscriber.on('message', this.onSubscriberMessage.bind(this));

    // update internal store if these channels are used
    subscriber.subscribe(this.keySpaceChannel(ChannelConfigSet));
    subscriber.subscribe(this.keySpaceChannel(ChannelConfigClear));

    return this;
  }

  /**
  * Ends the monitoring service.
  */
  stopMonitor(cb?: redis.Callback<'OK'>) : Registry {

    if(!this.subscriber) // already has an active subscriber client
      return this;

    this.subscriber.quit(cb);
    this.subscriber = null;

    return this;
  }
};

export default Registry;
