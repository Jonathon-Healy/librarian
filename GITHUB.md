# Publishing Librarian to GitHub (one-time, ~10 minutes)

After this, updating Librarian on any unraid server becomes a single click — no zip copying, no terminal builds.

## One-time setup

1. **Create a free account** at https://github.com/signup (skip if you have one).
2. **Create a repository:** github.com → "+" (top right) → *New repository* → name it `librarian` → Public → Create. (Public keeps the container image pull free and simple.)
3. **Upload the source:** on the new repo page click *uploading an existing file* → drag in the entire **contents** of the `librarian` folder from `Librarian.zip` (all files and subfolders: `server/`, `public/`, `unraid/`, `.github/`, `Dockerfile`, `package.json`, etc.) → *Commit changes*.
   - If your browser won't upload the `.github` folder, use the GitHub Desktop app instead: clone the repo, copy the files in, commit and push.
4. **Wait ~2 minutes.** The included GitHub Action builds the Docker image automatically. Check the *Actions* tab — green check means your image is live at `ghcr.io/YOUR-USERNAME/librarian:latest`.
5. **Make the image public:** repo page → *Packages* (right sidebar) → `librarian` → *Package settings* → *Change visibility* → Public.

## Point unraid at it

Docker tab → **Librarian** → **Edit** → change **Repository** from `librarian:latest` to:

```
ghcr.io/YOUR-USERNAME/librarian:latest
```

→ Apply. (Your friend does the same — or uses this repository string from the start.)

## Updating from now on

- **You (making changes):** edit files in the GitHub repo (or re-upload changed files) → commit → the Action rebuilds the image automatically.
- **Any server (getting updates):** Docker tab → *Check for Updates* → **apply update** on Librarian. That's it. No terminal, no zip, and container paths are never touched.
