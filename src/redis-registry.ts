import * as redis from 'redis';
import * as events from 'events';
import * as uuid from 'uuid/v4';
import { BinaryModel, DataType } from 'js-binary-model';

export const MessageModel = new BinaryModel({
  sender: DataType.STRING,
  arguments: DataType.JSON
});

export const MessageEncoding    = 'base64';
export const ChannelConfigSet   = 'ConfigSet';
export const ChannelConfigClear = 'ConfigClear';

export class SystemRegistry extends events.EventEmitter {

  clientConfig : redis.ClientOpts;
  keyspace : string;
  store : { [key: string] : any } = {};

  private subscriber : redis.RedisClient | null = null;
  private uniqId : string = uuid();

  constructor (clientConfig : redis.ClientOpts, keyspace: string = 'global') {
    super();

    this.clientConfig = clientConfig;
    this.keyspace = keyspace;

    // initialize and emit ready when so.
    this.pull(() => this.emit('ready'));
  }

  get keyConfig () : string {
    return 'config:' + this.keyspace;
  }

  protected emitError(err: Error) : void {
    this.emit('error', err);
  }

  protected emitUpdated() : void {
    this.emit('updated');
  }

  protected emitCleared(key: string) : void {
    this.emit('cleared', key);
    this.emitUpdated();
  }

  protected emitSet(key: string, value: any, previousValue: any) : void {
    this.emit('set', key, value, previousValue);
    this.emitUpdated();
  }

  protected getClient () : redis.RedisClient {
    return new redis.RedisClient(this.clientConfig);
  }

  protected publish(cli : redis.RedisClient, channel: string, ... args: any[]) : void {
    cli.publish(channel, MessageModel.encode({
      sender: this.uniqId,
      arguments: args
    }).toString(MessageEncoding));
  }

  protected applyEncodedKeyValue(key: string, value: string) : void {
    try { // decode all stored values
      this.store[key] = JSON.parse(value);
    }
    catch(e) {
    }
  }

  protected pull(onSuccess?: Function) : void {

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
  }

  protected keySpaceChannel(channel : string) : string {
    return `${channel}:${this.keyspace}`;
  }

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

  get (key: string, defaultValue: any = undefined) : any {

    if(!this.store.hasOwnProperty(key))
      return defaultValue;

    return this.store[key];
  }

  set (key: string, value : any) : SystemRegistry {

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

  clear (key: string) : SystemRegistry {

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

  startMonitor() : SystemRegistry {

    if(this.subscriber) // already has an active subscriber client
      return this;

    let subscriber = this.subscriber = redis.createClient(this.clientConfig);

    subscriber.on('message', this.onSubscriberMessage.bind(this));

    // update internal store if these channels are used
    subscriber.subscribe(this.keySpaceChannel(ChannelConfigSet));
    subscriber.subscribe(this.keySpaceChannel(ChannelConfigClear));

    return this;
  }

  stopMonitor(cb?: redis.Callback<'OK'>) : SystemRegistry {

    if(!this.subscriber) // already has an active subscriber client
      return this;

    this.subscriber.quit(cb);
    this.subscriber = null;

    return this;
  }
};

export default SystemRegistry;
