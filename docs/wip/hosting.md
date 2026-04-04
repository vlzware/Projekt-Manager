# Host a Node.js test app for $0/month

**The cheapest realistic setup for a two-service Node.js architecture with continuous deployment costs nothing.** Render's free tier handles the app server while Cloudflare R2's free tier provides S3-compatible file storage — both with GitHub-based CD, totaling **$0/month**. If you want to avoid entering a credit card entirely, swap to Koyeb + Backblaze B2 for the same $0 price tag. The free-tier landscape has shifted significantly since Heroku killed its free plan in 2022 — Railway and Fly.io followed suit — but several strong options remain in 2026 for test and demo workloads.

---

## The best free app hosting platforms for Node.js in 2026

The field has narrowed. Of the ten major platforms evaluated, only **four** offer genuinely free Node.js backend hosting without expiration, and each comes with trade-offs.

**Render** stands out as the most practical free option for a traditional Node.js backend. You get **512 MB RAM**, 0.1 CPU, 100 GB bandwidth, and 500 build minutes per month. The catch: your service **spins down after 15 minutes of inactivity**, producing cold starts of 5–30 seconds. No credit card is required. CD is built-in — connect your GitHub repo, and Render auto-deploys on every push to your tracked branch. No GitHub Actions workflow needed.

**Koyeb** offers a similar deal: one free web service (512 MB RAM, 0.1 vCPU) with built-in GitHub CD and no credit card required. It enforces scale-to-zero, producing **2–5 second cold starts** after idle periods. The free tier also includes a small Postgres database limited to 5 hours of active time. Available in Frankfurt, which is convenient for a Germany-based developer.

**Cloudflare Workers** provides 100,000 requests/day free with essentially zero cold starts, but it runs V8 isolates rather than a traditional Node.js runtime. As of late 2025, Express support exists via the `nodejs_compat` flag, but the **10 ms CPU time limit** on the free tier is extremely tight for anything beyond simple API responses. This is best for edge-native frameworks like Hono, not traditional Express/Fastify apps.

**Vercel** has a generous free tier but converts Express/Fastify apps into serverless functions with a **10-second execution limit**. No persistent processes, no WebSockets, no in-memory state. It's excellent for frontend frameworks but not suitable for practicing real backend architecture.

| Platform | Free tier | RAM | Sleeps? | CD setup | Credit card |
|---|---|---|---|---|---|
| **Render** | ✅ Permanent | 512 MB | After 15 min | Built-in GitHub | Not required |
| **Koyeb** | ✅ Permanent | 512 MB | Scale-to-zero | Built-in GitHub | Not required |
| **CF Workers** | ✅ 100K req/day | 128 MB | No (edge) | GitHub Actions + Wrangler | Not required |
| **Vercel** | ✅ Generous | N/A (serverless) | N/A | Built-in GitHub | Not required |
| Railway | ⚠️ $5 trial only | 1 GB | Stops when depleted | Built-in GitHub | Required |
| Fly.io | ❌ New users | 256 MB+ | Configurable | GitHub Actions + flyctl | Required |
| Heroku | ❌ Since 2022 | 512 MB | After 30 min (Eco) | Built-in Git | Required |

For the cheapest **paid** tier when you outgrow free plans, **Fly.io at ~$2–4/month** (pay-as-you-go for a shared-cpu-1x VM with 256 MB RAM) and **Railway at $5/month** (Hobby plan with $5 usage credit included) offer the best value. Railway has significantly better developer experience with zero-config deploys, while Fly.io gives more infrastructure control.

## Cloudflare R2 dominates free object storage

For S3-compatible file storage at test scale (1–5 GB), three services offer permanent free tiers with zero egress fees, but **Cloudflare R2** is the clear winner.

R2's free tier includes **10 GB of storage**, 1 million write operations, 10 million read operations per month, and — critically — **zero egress fees forever**. That last point is what separates it from AWS S3 ($0.09/GB egress) and Google Cloud Storage ($0.12/GB egress), where serving files to users gets expensive fast. R2 is fully S3-compatible, meaning you use the standard `@aws-sdk/client-s3` Node.js SDK pointed at Cloudflare's endpoint. The only downside: a credit card is required to activate R2, even on the free tier.

**Backblaze B2** is the runner-up with an identical **10 GB free** allowance and the notable advantage of **no credit card required** at signup. Its egress is free up to 3× your average stored data, and if you route traffic through Cloudflare's CDN (free plan), egress from B2 to Cloudflare costs nothing via the Bandwidth Alliance. B2 is fully S3-compatible.

**Tigris** (backed by Fly.io) offers 5 GB free with zero egress, and **Oracle Cloud Object Storage** provides a generous 20 GB free with 10 TB of egress — though Oracle's console is notoriously complex and accounts can be reclaimed for inactivity.

| Storage service | Free storage | Free egress | S3-compatible | Credit card | Best for |
|---|---|---|---|---|---|
| **Cloudflare R2** | 10 GB | Unlimited | ✅ Full | Required | Best overall free option |
| **Backblaze B2** | 10 GB | 3× stored (unlimited via CF CDN) | ✅ Full | Not required | No-CC option |
| **Tigris** | 5 GB | Unlimited | ✅ Full | Required (Fly.io) | Fly.io ecosystem |
| **Oracle Cloud** | 20 GB | 10 TB/mo | ✅ Compat mode | Required | Maximum free capacity |
| AWS S3 | 5 GB | 100 GB/mo | ✅ Native | Required | AWS ecosystem familiarity |

Avoid **Hetzner Object Storage** ($5.99/month minimum for 1 TB — absurd for 5 GB of test data), **Wasabi** ($6.99/month minimum with 1 TB floor), and **Supabase Storage** (only 1 GB free, not S3-compatible, projects auto-pause after one week of inactivity).

## Setting up CD pipelines that cost nothing

**GitHub Actions is free and more than sufficient.** Public repositories get unlimited Linux runner minutes. Private repositories on the free plan get **2,000 minutes/month** — enough for 400–1,000 typical Node.js deployments. A standard build-and-deploy takes 2–5 minutes.

The CD experience varies significantly by platform. Render, Koyeb, Railway, and Vercel all offer **native GitHub integration** — connect your repo in their dashboard, and pushes auto-trigger deployments with no workflow file needed. This is the simplest path for the app server.

For object storage, you'll write a **GitHub Actions workflow** regardless of which provider you choose. This is actually a benefit — it gives you hands-on practice with real CI/CD pipelines. A minimal R2 sync workflow looks like this:

```yaml
name: Sync storage
on:
  push:
    branches: [main]
    paths: [assets/**]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          aws s3 sync ./assets s3://my-bucket \
            --endpoint-url https://${{ secrets.CF_ACCOUNT_ID }}.r2.cloudflarestorage.com
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_KEY }}
```

This two-pattern setup — built-in CD for the app, GitHub Actions for storage — is ideal for learning because you experience both approaches. For maximum CD practice, Fly.io and Cloudflare Workers also require GitHub Actions workflows for app deployment (using `flyctl deploy` or the `wrangler-action`), giving you end-to-end pipeline experience.

Practical tips to keep in mind: use `concurrency` groups to cancel redundant deploys, cache `node_modules` to speed up builds, set `timeout-minutes: 10` to avoid burning minutes on stuck jobs, and use a **public repo** if possible for unlimited free Actions minutes.

## Three recommended combinations ranked by cost

**Combo 1 — Render + Cloudflare R2: $0/month (recommended)**
This is the best balance of simplicity, realism, and cost. Render gives you a genuine Node.js web service with native GitHub CD. R2 gives you 10 GB of S3-compatible storage with zero egress. You practice two CD patterns: Render's built-in deploy plus a custom GitHub Actions workflow for R2. The main trade-off is **cold starts** on Render's free tier (5–30 seconds after 15 minutes idle) and the requirement to enter a credit card for R2. Total monthly cost: **$0**.

**Combo 2 — Koyeb + Backblaze B2: $0/month, no credit card**
The only combination where **neither service requires a credit card**. Koyeb provides a free Node.js web service in Frankfurt with built-in GitHub CD. B2 provides 10 GB of S3-compatible storage. Cold starts are slightly shorter than Render (2–5 seconds). B2's egress is free up to 3× stored data. If you proxy B2 through Cloudflare's free CDN tier, egress becomes unlimited. This is the lowest-friction starting point. Total monthly cost: **$0**.

**Combo 3 — Coolify on Oracle Cloud + Cloudflare R2: $0/month, maximum power**
For those willing to invest setup time, Oracle Cloud's Always Free tier provides up to **4 ARM cores and 24 GB RAM** — enormously more powerful than any PaaS free tier. Install Coolify (open-source PaaS) on it for GitHub-integrated CD, custom domains, and auto-SSL. Pair with R2 for storage. The catch: Oracle ARM instances are notoriously hard to provision due to capacity constraints, the setup is complex, and Oracle may reclaim idle resources. This is the "power user" path. Total monthly cost: **$0**.

## What to watch out for

Several platforms that once offered free tiers have pulled them back. **Railway** now provides only a one-time $5 trial credit (30 days), then requires the $5/month Hobby plan. **Fly.io** eliminated its free tier for new users in October 2024 — new signups get just 2 VM-hours or 7 days of trial. **Heroku's** cheapest option is the $5/month Eco dyno that still sleeps after 30 minutes. These three are no longer competitive for zero-cost test deployments.

On the storage side, **AWS S3's free tier expires after 12 months** for new accounts — it is not "always free" despite the 5 GB allowance. Google Cloud Storage's 1 GB/month egress limit makes it impractical for anything that serves files to users. And both **Wasabi and Hetzner Object Storage** have minimum monthly charges ($6.99 and $5.99 respectively) that make zero sense for a few gigabytes of test data.

For the app hosting free tiers that do exist, cold starts are the universal tax. Render sleeps after 15 minutes, Koyeb scales to zero, and serverless platforms have function initialization overhead. For a test/demo app, this is acceptable — just set expectations that the first request after idle will be slow.

## Conclusion

The modern free tier landscape still supports a fully functional two-service architecture with real CD pipelines at zero cost. **Render + Cloudflare R2** is the recommended starting point: it provides a traditional Node.js server, S3-compatible storage, and two distinct CD patterns to practice — all without spending a cent. For those who want to avoid credit cards entirely, **Koyeb + Backblaze B2** achieves the same thing. The only real costs you'll encounter are cold starts and the time spent configuring your pipeline — both worthwhile investments for a learning environment.