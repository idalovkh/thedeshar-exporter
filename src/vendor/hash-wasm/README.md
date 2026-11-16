# SHA-256 из hash-wasm 4.12.0

Используется оригинальный `dist/sha256.umd.min.js` из
[официального npm-релиза](https://registry.npmjs.org/hash-wasm/-/hash-wasm-4.12.0.tgz).
Пакет npm проверяется по опубликованному значению `dist.integrity`:

```text
sha512-+/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ==
```

`LICENSE.txt` взят из корня пакета. `LICENSE-SHA256.txt` содержит
уведомление из `src/sha256.c`. `npm run check` сверяет SHA-256 файлов,
которые поставляются с расширением.
