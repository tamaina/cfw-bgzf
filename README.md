# cfw-bgzf

Minimum reproduction for `tamaina/cfw-fileup#121`.

This Worker builds a BGZF `tar.gz` from the two JPEG files in this directory and exposes three download paths:

- `GET /tar.gz`: returns the BGZF `tar.gz` as-is, so the client expands a tar file.
- `GET /entry/P2180294.jpg` and `GET /entry/P2180334.jpg`: mimics `cfw-fileup` targz entry download. It trims tar header/footer bytes from the first/final BGZF blocks, re-compresses those edge blocks, streams the middle BGZF blocks unchanged, and returns the result with `Content-Encoding: gzip`.
- `GET /entry-buffered/P2180294.jpg` and `GET /entry-buffered/P2180334.jpg`: same as `/entry/*`, but materializes the full response body before returning it.
- `GET /entry-tar/P2180294.jpg` and `GET /entry-tar/P2180334.jpg`: trims to a single tar entry, appends a tar EOF block, and returns it as `Content-Type: image/jpeg` with `Content-Encoding: gzip`.
- `GET /entry-tar-buffered/P2180294.jpg` and `GET /entry-tar-buffered/P2180334.jpg`: same as `/entry-tar/*`, but materializes the full response body before returning it.

## Commands

```sh
pnpm install
pnpm run build
pnpm run check
pnpm exec wrangler dev --ip 127.0.0.1 --port 8787
```

`pnpm run build` always regenerates:

- `dist/public/photos.tar.gz`
- `dist/public/photos.index.json`

Deploying also rebuilds the fixture:

```sh
pnpm run deploy
```

## Local Checks

```sh
curl -sS http://127.0.0.1:8787/tar.gz -o /tmp/photos.tar.gz
gzip -t /tmp/photos.tar.gz
tar -tzf /tmp/photos.tar.gz

curl -sS http://127.0.0.1:8787/entry/P2180294.jpg -o /tmp/P2180294.entry.gz
gzip -cd /tmp/P2180294.entry.gz > /tmp/P2180294.entry.jpg
cmp P2180294.jpg /tmp/P2180294.entry.jpg

curl -sS http://127.0.0.1:8787/entry/P2180334.jpg -o /tmp/P2180334.entry.gz
gzip -cd /tmp/P2180334.entry.gz > /tmp/P2180334.entry.jpg
cmp P2180334.jpg /tmp/P2180334.entry.jpg

curl -sS http://127.0.0.1:8787/entry-tar/P2180294.jpg -o /tmp/P2180294.entry.tar.gz
tar -tzf /tmp/P2180294.entry.tar.gz
tar -xOzf /tmp/P2180294.entry.tar.gz P2180294.jpg > /tmp/P2180294.entry-tar.jpg
cmp P2180294.jpg /tmp/P2180294.entry-tar.jpg

curl -sS --compressed http://127.0.0.1:8787/entry-tar/P2180294.jpg -o /tmp/P2180294.entry.tar
tar -tf /tmp/P2180294.entry.tar

curl -sS http://127.0.0.1:8787/entry-buffered/P2180294.jpg -o /tmp/P2180294.entry-buffered.gz
gzip -cd /tmp/P2180294.entry-buffered.gz > /tmp/P2180294.entry-buffered.jpg
cmp P2180294.jpg /tmp/P2180294.entry-buffered.jpg

curl -sS http://127.0.0.1:8787/entry-tar-buffered/P2180294.jpg -o /tmp/P2180294.entry-tar-buffered.gz
tar -tzf /tmp/P2180294.entry-tar-buffered.gz
```

For client-side `Content-Encoding` behavior:

```sh
curl -v --compressed http://127.0.0.1:8787/entry/P2180294.jpg -o /tmp/P2180294.curl-decoded.jpg
```
