# `src/pds/`

The PDS itself. Everything in this tree is server code — none of it depends on
React, the router, or the docs UI. Each subdirectory matches a chapter in
[`/docs`](../../docs/README.md) and is small enough to read top-to-bottom.

| Subsystem | Lives in | Tutorial chapter |
| --- | --- | --- |
| Content-addressing & IPLD | [`codec/`](./codec/README.md) | [05](../../docs/05-cid-and-dagcbor.md) |
| Merkle Search Trees | [`repo/`](./repo/README.md) | [06](../../docs/06-merkle-search-tree.md) |
| Repository commits & signing | [`repo/`](./repo/README.md) | [07](../../docs/07-commits-and-signing.md) |
| CAR file encoding | [`car/`](./car/README.md) | [08](../../docs/08-car-files.md) |
| DIDs & identity | [`did/`](./did/README.md) | [04](../../docs/04-data-model.md) |
| Lexicon schemas | [`lexicon/`](./lexicon/README.md) | [09](../../docs/09-lexicons.md) |
| XRPC server | [`xrpc/`](./xrpc/README.md) | [10](../../docs/10-xrpc.md) |
| Authentication | [`auth/`](./auth/README.md) | [13](../../docs/13-authentication.md) |
| Blob storage | [`blob/`](./blob/README.md) | [15](../../docs/15-blobs.md) |
| Event sequencer | [`sequencer/`](./sequencer/README.md) | [16](../../docs/16-firehose.md) |

## Layering

Higher modules import lower modules; lower modules know nothing about higher
ones. Roughly:

```
xrpc  →  lexicon  →  repo  →  car  →  codec
                  ↘  did
                  ↘  auth
                  ↘  blob
                  ↘  sequencer
```

If you ever need to break that order, that's a strong signal you've found a
seam worth a chapter of its own.
