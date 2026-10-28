# TQQQ Recovery V2.0 on Vercel

This repository holds the dashboard already built for Vercel. Vercel runs nothing but a file check at build time.

```
vercel.json        build check, function, Singapore region (sin1), routing
package.json       Node.js 22
api/index.mjs      the whole dashboard: one Vercel function (built from the source package)
public/robots.txt  keeps search engines out
```

All four must sit at the top level of the repository, or in the folder set as **Root Directory** in Vercel's project settings.

## Set up

1. **Database.** In the Vercel project: *Storage → Create Database → Upstash for Redis*, free plan, **Singapore (ap-southeast-1)** region, connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. **Secrets.** *Settings → Environment Variables*: `TWELVE_DATA_API_KEY` and `DASHBOARD_PASSWORD`, both marked **Sensitive**.
3. **Redeploy.** *Deployments → ⋯ → Redeploy*. New variables only reach new deployments.
4. Open `https://<your-project>.vercel.app` and sign in.

Until steps 1–3 are done, the site shows a page listing what is missing.

If you choose a different Upstash region, change `"regions"` in `vercel.json` to the Vercel region next to it (for example `iad1` for us-east-1).

## Updating

Changes are made in the source package (`tqqq-recovery-v2.zip`): run `node build.mjs` there, then replace `api/index.mjs` here. Each commit to this repository deploys automatically.

Decision support only: the dashboard never places orders.
