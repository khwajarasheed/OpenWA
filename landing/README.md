# ForgeScale Relay landing site

This folder is the public ForgeScale Relay marketing website. It is owned and deployed by the ForgeScale Relay project, not by customers who deploy ForgeScale Relay Core.

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

The customer-facing **Deploy to Cloudflare** button in this site deploys the ROOT ForgeScale Relay Worker project into the customer’s own Cloudflare account. Do not point it to this `landing/` directory.
