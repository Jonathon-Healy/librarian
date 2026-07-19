# Librarian

Audiobook automation for unraid. Search Audible's catalog, grab torrents through Prowlarr, download with qBittorrent, and auto-import finished books into AudioBookShelf as `Author/Title` — with a mobile-first UI, multiple accounts, and TOTP two-factor auth.

## Install on unraid

**Step 1 — copy the source to the server.**
Copy `Librarian.zip` to your appdata share, e.g. `\\YOUR-SERVER\appdata\Librarian.zip` from Windows.

**Step 2 — build the image + install the template.** Open the unraid web terminal (>_ icon) and paste this whole block:

```
cd /mnt/user/appdata \
&& rm -rf librarian-src \
&& unzip -o Librarian.zip -d librarian-src \
&& docker build -t librarian:latest librarian-src/librarian \
&& mkdir -p /boot/config/plugins/dockerMan/templates-user \
&& cp librarian-src/librarian/unraid/my-Librarian.xml /boot/config/plugins/dockerMan/templates-user/my-Librarian.xml \
&& echo '=== Librarian image built and template installed ==='
```

**Step 3 — add the container from the GUI.**
Docker tab → **Add Container** → in the *Template* dropdown pick **Librarian** → check the three paths (Downloads must match qBittorrent's download folder, Audiobook Library must match AudioBookShelf's library folder) → **Apply**.

**Step 4 — first run.**
Open `http://YOUR-SERVER-IP:8787`, create the admin account, scan the QR with your authenticator app. Then in Settings → Connections press **Scan for services**, fill in the credentials, and test each one.

## Alternative: run entirely from the CLI

If you'd rather skip the GUI form (the container still shows on the Docker tab):

```
docker rm -f Librarian 2>/dev/null ; docker run -d \
  --name=Librarian \
  --restart=unless-stopped \
  -p 8787:8787 \
  -e PUID=99 -e PGID=100 \
  -v /mnt/user/appdata/librarian:/config \
  -v /mnt/user/data/torrents:/downloads \
  -v /mnt/user/media/audiobooks:/audiobooks \
  librarian:latest
```

Adjust the two media paths to your shares.

## Updating after a code change

Re-copy the new `Librarian.zip`, then paste this block — note it does **not** copy the template again (unraid stores your customized paths in that template file; overwriting it would reset them to defaults):

```
cd /mnt/user/appdata \
&& rm -rf librarian-src \
&& unzip -o Librarian.zip -d librarian-src \
&& docker build -t librarian:latest librarian-src/librarian \
&& echo '=== rebuilt ==='
```

Then recreate the container so it picks up the new image: Docker tab → **Librarian** → **Edit** → **Apply** (a plain restart reuses the old image and is not enough).

## Where credentials live in each app

- **qBittorrent** — the web UI username/password (Settings → Web UI in qBittorrent).
- **Prowlarr API key** — Prowlarr → Settings → General → API Key.
- **AudioBookShelf token** — ABS → Settings → Users → click your user → API Token.

## How importing works

Librarian tags every torrent it adds (`librarian-<id>`, category `librarian`) and polls qBittorrent every 10 s. When a torrent finishes, the audio files are **copied** (so the torrent keeps seeding) into `LIBRARY/Author/Title/`, ownership is set to PUID:PGID, and an AudioBookShelf library scan is triggered.

If qBittorrent reports paths Librarian can't see (different mount layout), set **Settings → Paths → Remote path mapping** in the web UI.
