# PDS vs AppView vs Relay

> 🚧 Conceptual chapter, no implementation here.

You've built a PDS. Now look at it from outside, and at the other two
species of server in the AT Protocol ecosystem: the **Relay** (also called
BGS, "Big Graph Service" historically) and the **AppView**.

## Outline

1. **The PDS** — what you've built. Owns repositories, signs commits,
   emits a firehose, serves the write API.
2. **The Relay** — a fan-in service. Subscribes to many PDSes' firehoses,
   merges into one global ordered stream. Stateless in the sense that it
   doesn't *interpret* records; it just rebroadcasts. Bluesky's reference
   relay is at `bsky.network`.
3. **The AppView** — the "Bluesky" experience. Subscribes to the relay,
   indexes every post, computes feeds, serves timelines, runs the
   moderation pipeline. `bsky.app` is one; you could run another.
4. **What clients talk to.** Reads go to the user's preferred AppView via
   `service-proxy` headers. Writes go to the user's PDS. The client knows
   to split traffic.
5. **Federation.** Every PDS publishes a firehose; any relay can read any
   PDS; any AppView can read any relay. There's no privileged hub.
6. **Backfill.** When a relay first hears about a PDS, it can request the
   PDS's repo list and pull each one from scratch.

← [16 — Firehose](./16-firehose.md) · → [18 — Production](./18-production.md)
