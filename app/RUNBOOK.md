# RUNBOOK — Court & Fairway

## Run locally

```bash
cd ~/court-and-fairway/app && python3 -m http.server 8787
```

Open http://localhost:8787

## Deploy (GitHub Pages — already done)

The repo is `git@github.com:ewing-operating-system/court-and-fairway.git`.
Pages serves the `app/` folder from `main`. To ship a change:

```bash
cd ~/court-and-fairway && git add -A && git commit -m "update" && git push
```

Live URL: https://ewing-operating-system.github.io/court-and-fairway/

## Add to iPhone home screen (Safari, not Chrome)

1. Open **Safari** on the iPhone.
2. Go to https://ewing-operating-system.github.io/court-and-fairway/
3. Tap the **Share** button (square with the up arrow, bottom center).
4. Tap **Add to Home Screen**.
5. Tap **Add** (top right).
6. Open the app from the **Court&Fairway** icon on the home screen, not from Safari.

## Backup rule

The data lives only on the phone. Export is the only backup that exists.
In the app: **More → Export backup (JSON)**. Do it after every 10 sessions.
