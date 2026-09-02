# OpenWA landing site

This folder is the public OpenWA marketing website. It is owned and deployed by the OpenWA project, not by customers who deploy OpenWA CORE.

## Deploy to Cloudflare Pages

In your Cloudflare account, create a Pages project from `khwajarasheed/OpenWA` and configure:

- **Production branch:** `main`
- **Root directory:** `landing`
- **Build command:** leave blank
- **Build output directory:** `.`

Alternatively, from the repository root:

```bash
npm run landing:deploy
```

The customer-facing **Deploy to Cloudflare** button in this site deploys the ROOT OpenWA Worker project into the customer’s own Cloudflare account. Do not point it to this `landing/` directory.
