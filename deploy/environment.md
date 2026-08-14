# Hosted environment contract

PayOps treats configuration as capability assignment. A secret store must inject values at runtime; do not bake them into images, build arguments, labels, Compose files, or browser variables.

| Service        | Database variables                                   | Other required capability                                                           |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| role bootstrap | `PAYOPS_DATABASE_ADMIN_URL`                          | Five restricted login principal names                                               |
| migrator       | `PAYOPS_MIGRATOR_DATABASE_URL`                       | None                                                                                |
| API            | runtime, production-control, readiness-verifier URLs | HTTPS origins, dual RPC identity, auth/checkout keys, Pyth, email, evidence signing |
| worker         | runtime and shadow-projector URLs                    | dual RPC identity and bounded worker settings                                       |
| web            | none                                                 | exact web/API origins; only `NEXT_PUBLIC_PAYOPS_API_ORIGIN` is client-visible       |

The administrator is used only to create restricted principals and capability roles. Remove it from the deployment job before migrations. The migrator is a one-shot capability and must never be present in API, worker, or web.

Production requires `PAYOPS_ENVIRONMENT=production`, HTTPS exact origins, `mainnet-beta`, two distinct provider IDs with separately named endpoint variables, production email delivery, and an Ed25519 evidence-signing key. Without both authenticated commercial-FX variables, only USD invoices are enabled.

`BETTER_AUTH_SECRETS`, checkout token keys, evidence keys, database URLs/passwords, provider tokens, email tokens, and endpoint-specific webhook sender secrets are secret. Values in `.env.example` are inventory markers, not usable defaults.
