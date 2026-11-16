/* This isolated-world file is injected only on an explicitly connected source site. */
(() => {
  'use strict';
  if (location.protocol === 'https:' && !location.port) {
    Object.defineProperty(globalThis, '__thedesharExporterSourceOrigin', { value: location.origin, configurable: true });
  }
})();
