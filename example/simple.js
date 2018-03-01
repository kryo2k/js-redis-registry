const systemRegistry = require('js-redis-registry');

let registry = new systemRegistry.SystemRegistry({
  host: '127.0.0.1',
  port: 6379,
  db:   0
});

['ready','error','updated','cleared','set'].forEach(evt => registry.on(evt, function () { console.log('[%s] %j', evt, arguments); }))

registry.watch('label1', nV => {
  console.log('Label-1 changed:', nV);
});

registry.on('ready', () => {
  console.log('registry is ready');

  registry.startMonitor();

  console.log(registry.store);

  registry.set('label1', 'Some Value: ' + Date.now());
  registry.set('label2', 'Some other value: ' + Date.now());

});

