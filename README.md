# Fast Clone — Internet Speed Test

A [fast.com](https://fast.com)-style internet speed test you host on your own server.
Zero dependencies: just Node.js.

- Download speed starts automatically and shows as one big live number
- **Show more info** shows latency (unloaded / loaded), upload speed, client IP and server
- Settings: parallel connections, test duration, auto upload
- Dark mode, mobile friendly

## Install (one command)

Run as root on Ubuntu / Debian / CentOS / Rocky / Alma / Fedora:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh)
```

Options:

```bash
# custom port and server name
bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh) --port 80 --location "Tehran"

# uninstall
bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh) --uninstall
```

The installer installs Node.js if needed, puts the app in `/opt/fast-clone`, creates a
`fast-clone` systemd service and opens the port in ufw/firewalld. Running the same
command again updates to the latest version and keeps your port and location.

```bash
systemctl status fast-clone      # status
systemctl restart fast-clone     # restart
journalctl -u fast-clone -f      # logs
```

If your cloud provider has its own firewall, open the port there too.

## Run locally

```bash
git clone https://github.com/hamedbaftam/fast.git
cd fast
node server.js          # http://localhost:3000
```

Environment variables: `PORT` (default `3000`), `SERVER_LOCATION` (default: hostname).

## API

| Endpoint | Description |
|---|---|
| `GET /api/download?bytes=N` | Streams N random bytes (max 100 MB) |
| `POST /api/upload` | Discards the body, returns `{ bytes }` |
| `GET /api/ping` | Tiny response for latency |
| `GET /api/info` | `{ ip, server }` |

## Behind nginx

Results measure the path between the user and *this* server. If you put it behind a reverse
proxy, disable buffering and gzip for `/api/`, set `client_max_body_size 100m;`, and pass
`X-Forwarded-For` so the client IP is shown correctly.

## License

MIT
