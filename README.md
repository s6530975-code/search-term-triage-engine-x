# Search Term Triage Engine

An explainable search-term triage and decision-intelligence application for Google Ads. The application includes a React dashboard, a local Express API, sample search-term data, CSV import, review tracking, clustering, reports, and an optional Google Ads OAuth integration.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm
- Visual Studio Code (optional)

## Run locally

Open a PowerShell terminal in the project root:

```powershell
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development command starts the Express API and serves the Vite-powered frontend from the same local server.

Useful commands:

```powershell
npm run lint    # TypeScript check
npm run build   # Create the production frontend in dist/
npm run clean   # Remove dist/
```

To run the production build locally:

```powershell
npm run build
$env:NODE_ENV = "production"
npm start
```

The application server listens on port 3000 by default. Set `$env:PORT` before starting it to choose another port.

## Google Ads OAuth (optional)

The application works in sample-data mode without credentials. To enable its Google Ads integration:

1. Copy `.env.example` to `.env`.
2. Set `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `GOOGLE_ADS_DEVELOPER_TOKEN` to your own Google Ads API credentials.
3. Configure the OAuth redirect URI in Google Cloud to match `GOOGLE_ADS_REDIRECT_URI` (by default `http://localhost:3000/auth/google/callback`).
4. Restart the server.

Never commit `.env` or OAuth credentials. Local reviews, settings, and OAuth tokens are written under `data/`, which is ignored by Git.

## Project layout

```text
search-term-triage-engine/
├── src/
│   ├── components/
│   ├── utils/
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css
│   └── types.ts
├── .env.example
├── index.html
├── package.json
├── server.ts
├── tsconfig.json
└── vite.config.ts
```

The API server creates its local `data/` files on first run. Imported CSV data is kept in browser local storage.

## Open in VS Code

From PowerShell, run:

```powershell
Set-Location "C:\Users\ilakk\Downloads\search-term-triage-engine"
code .
```

If `code` is not available in PowerShell, open this folder using **File > Open Folder** in VS Code.

## Publish to GitHub

This project is initialized as a Git repository on branch `main`. Check the configured remote before pushing:

```powershell
Set-Location "C:\Users\ilakk\Downloads\search-term-triage-engine"
git status --short --branch
git remote -v
```

The ignore rules exclude dependencies, build output, local environment files, and generated application data. After reviewing `git status`, add the complete project (including `src` and its nested folders), commit, and push:

```powershell
git add .
git commit -m "Prepare Search Term Triage Engine for GitHub"
git push -u origin main
```

If `git remote -v` shows no remote, create an empty GitHub repository and connect it before pushing. Replace the URL below with your repository's HTTPS or SSH URL:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/search-term-triage-engine.git
git push -u origin main
```

Do not run `git remote add origin` if a remote is already configured.
