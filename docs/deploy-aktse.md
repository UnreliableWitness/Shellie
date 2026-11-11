# Shellie Reader on aktse

The phone reading site and its server (`reader/`, design in
`docs/superpowers/specs/2026-11-11-phone-reader-design.md`) run on aktse, the owner's home server
(`ssh dries@aktse.local`). This is apart from the Shellie app: a release of the app deploys nothing here, and a
deploy here makes no app version.

## What runs where

One container, `shellie-reader`: the stock `node:24-alpine` image running one bundled file. No image is built.

```
/opt/shellie-reader/
  docker-compose.yml   copy of deploy/aktse/docker-compose.yml
  .env                 READER_INVITE=<the invitation code>, chmod 600
  app/                 the contents of reader/dist: server.mjs and public/ (mounted read-only)
  data/                the accounts: data/readers/<reader id>/{reader.json, items/}
```

- The server writes its log to the container's output (`docker compose logs`); there is no `logs/` folder. A line
  is time, method, path, status and size, with `:id` in place of an item's id: no reader id, token or content.
- The container runs as user `1000:1000` with a read-only root, so `data/` must belong to user 1000 (`dries` on
  aktse).
- It listens on `127.0.0.1:8091` on aktse and as `shellie-reader:8080` on the Docker network `adem_default`,
  where the Cloudflare tunnel's cloudflared container reaches it.
- Limits: half a CPU, 256 MB.

## First time

On aktse:

```sh
sudo mkdir -p /opt/shellie-reader && sudo chown dries: /opt/shellie-reader
cd /opt/shellie-reader && mkdir -p app data
```

From the repo on the Mac:

```sh
scp deploy/aktse/docker-compose.yml dries@aktse.local:/opt/shellie-reader/docker-compose.yml
scp deploy/aktse/.env.example dries@aktse.local:/opt/shellie-reader/.env
```

On aktse, put the invitation code in `.env` (see below) and `chmod 600 .env`. Then deploy as below.

The public hostname is the owner's step, in the Cloudflare dashboard: Zero Trust › Networks › Tunnels › `aktse` ›
Public Hostname › Add: the hostname, type HTTP, URL `shellie-reader:8080`.

## Deploy

From the repo on the Mac:

```sh
node tools/reader/build.mjs
rsync -a --delete reader/dist/ dries@aktse.local:/opt/shellie-reader/app/
ssh dries@aktse.local 'cd /opt/shellie-reader && docker compose up -d && docker compose restart shellie-reader'
```

Without rsync (aktse had none on 2026-11-11, so this is the one that works today):

```sh
tar -C reader/dist -czf - . | ssh dries@aktse.local 'tar -C /opt/shellie-reader/app -xzf -'
```

(`tar` adds and replaces files but removes none; old hashed files under `app/public/assets/` then stay until
someone clears them.)

The build prints what it made: `reader/dist/server.mjs` and `reader/dist/public/`. The site's files are read from
disk on each request, so a change to the site alone is live after the copy; a change to `server.mjs` needs the
restart. When `deploy/aktse/docker-compose.yml` changed, copy it over first.

## Check

On aktse:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8091/health
```

must print `200`. Then the same for the public URL, `https://<hostname>/health`. If not:

```sh
cd /opt/shellie-reader && docker compose ps && docker compose logs --tail 50 shellie-reader
```

## The invitation code

Whoever has the code can make an account; it is asked once, in Shellie under Settings › User › Phone. Accounts that
exist do not need it again.

```sh
openssl rand -base64 32    # a new code
```

Put it in `/opt/shellie-reader/.env` as `READER_INVITE=<code>`, then `docker compose up -d` (it restarts the
container with the new value; `restart` alone does not read `.env` again). Leave it empty to close sign-ups. Never
commit the code or paste it in chat.

## Accounts

An account is a folder: `data/readers/<reader id>/`. The server cannot tell whose it is; a person finds their
reader id nowhere in Shellie, so match on dates and sizes.

```sh
cd /opt/shellie-reader
ls -l data/readers/                 # the accounts, with the date each was last changed
du -sh data/readers/*               # their sizes
ls data/readers/<reader id>/items | wc -l
```

Remove one:

```sh
rm -r data/readers/<reader id>
docker compose restart shellie-reader
```

The restart matters: the server keeps the accounts it has seen in memory. Disconnecting in Shellie (Settings ›
User › Phone › Disconnect) removes the person's account without any of this.

Limits per account, in `reader/server/server.ts`: an item 1 MB, 2000 items, 200 MB, 1200 requests a minute; and 20
refused logins or sign-ups a minute per address.

## Backup

Copy `data/`. It holds ciphertext and, per account, a hash of its token: nothing in it can be read without the
secret that lives in the person's Shellie and on their phone. Losing it loses nothing for good either: Shellie
sends everything again once a person reconnects.

## What the server's owner can and cannot see

The server sees, per account, how many items there are, their kind letter, sizes and times. It cannot read a
title, a path or a text. Honest limit: the site's code comes from this server, so whoever controls the server
could serve code that sends the secret away. The encryption protects against a copied disk or backup, not against
that.
