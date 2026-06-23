# Website

Static website served at [www.ename.ngo](https://www.ename.ngo), hosted on Scaleway Object Storage.

## Structure

- `src/` — the static site that gets deployed (HTML and assets).
- `scripts/` — deployment tooling.

## Deployment

The site is deployed by syncing `src/` to the Scaleway Object Storage bucket `www.ename.ngo`.

### Prerequisites

- The [AWS CLI](https://aws.amazon.com/cli/) installed.
- An AWS profile named `ename` in `~/.aws/credentials` holding the Scaleway API keys.

### Deploy

```bash
./scripts/deploy.sh            # deploy
./scripts/deploy.sh --dryrun   # simulate without writing anything
```

The script runs `aws s3 sync` against the Scaleway endpoint (`fr-par` region by default). It mirrors `src/` to the bucket with `--delete` (removes objects no longer present locally) and excludes `.DS_Store` files. Any extra argument is forwarded to `aws s3 sync`.

If the bucket lives in another region, update the `ENDPOINT` variable at the top of `scripts/deploy.sh`.
