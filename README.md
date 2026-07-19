# Librarian — Install Guide (unraid)

Librarian is a self-hosted audiobook automation app with a clean, phone-first web UI. You search Audible's catalog; Librarian finds torrent releases through **Prowlarr**, downloads them with **qBittorrent**, and auto-imports finished books into **AudioBookShelf** as `Author/Title`, triggering a library scan. Multiple accounts, each with authenticator-app two-factor login.

## What you need

- unraid with Docker enabled
- **qBittorrent** (any recent version, including 5.x and VPN-wrapped containers)
- **Prowlarr** with at least one indexer that carries audiobooks
- **AudioBookShelf** with an audiobook library created

## Install (5 minutes)

Docker tab → **Add Container** → fill in:

| Field | Value |
|---|---|
| **Name** | `Librarian` |
| **Repository** | `ghcr.io/jonathon-healy/librarian:latest` |
| **Network Type** | Bridge |

Then **Add another Path, Port, Variable** three times for paths and once for the port:

| Type | Container path | Host path |
|---|---|---|
| Port | `8787` | `8787` (or any free port) |
| Path | `/config` | `/mnt/user/appdata/librarian` |
| Path | `/downloads` | **The same host folder qBittorrent downloads into** |
| Path | `/audiobooks` | **The same host folder your AudioBookShelf library reads** |

Getting those last two right is 90% of the setup. To see any container's real mounts, run this in the unraid terminal:

```
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' CONTAINER-NAME
```

Find qBittorrent's download mount and ABS's library mount, and copy their **host path** sides. Optionally add Variables `PUID`/`PGID` (defaults 99/100). Click **Apply** — unraid pulls the image and starts it.

## First run

1. Open `http://YOUR-SERVER-IP:8787` (phone works great — use Chrome menu → *Add to Home screen* for an app icon).
2. Create the admin account and scan the QR with any authenticator app (Google Authenticator, Authy, 1Password…).
3. **Settings → Connections** → press **Scan for services** to auto-fill the URLs, then add:
   - qBittorrent web UI username/password
   - Prowlarr API key (Prowlarr → Settings → General)
   - AudioBookShelf API token (ABS → Settings → Users → your user) — then **Load** and pick your library
   - Optional: a notification URL (ntfy topic, Discord webhook, or Gotify) for "book ready" pushes
4. Test each card (should go green), **Save connections**.
5. **Settings → Paths → Remote path mapping**: if qBittorrent calls its download folder something different inside its container (commonly `/data`), enter that as "Path in qBittorrent" and `/downloads` as "Same folder in Librarian". Leave blank if both already use the same internal path.
6. **Settings → Users**: add accounts for family. The **Auto-pick** option (on by default) makes Librarian download the best release automatically — ideal for non-technical users. New users scan their own MFA QR on first sign-in.

## Using it

Search a title, author, "title by author", or ISBN → tap the book → **Find releases**. The indexer search runs in the background and shows in **Activity**: auto-pick users see it start downloading by itself; others tap **Choose release** when it's *Ready for selection*. If nothing is found, the book goes to **Wanted** and Librarian re-checks your indexers twice a day until a release appears. Finished books are copied into your library as `Author/Title` (the torrent keeps seeding) and AudioBookShelf rescans automatically. Search results with a green **✓ In library** badge are ones you already own.

Regular users can search and download; only admins can remove Activity items or change settings.

## Updating

Docker tab → **Check for Updates** → apply the update on Librarian. That's it.

## Troubleshooting

- **qBittorrent test fails** — the error names the cause: IP ban from failed logins (restart the qBittorrent container), "Enable Host header validation" in qBittorrent's WebUI security settings (untick it), or wrong credentials.
- **Import fails, "Download not visible to Librarian"** — the `/downloads` host path doesn't match qBittorrent's, or the remote path mapping is wrong. The error shows the path qBittorrent reported; line the settings up and hit **Retry**.
- **Import succeeds but no book in ABS** — the `/audiobooks` host path doesn't match the folder your ABS library actually reads, or no library is selected in Settings → Connections.
- **Yellow "can't reach qBittorrent" banner in Activity** — qBittorrent is down/unreachable; clears itself when it's back.
