# PayOps reference integration

This framework-neutral example shows the two trust boundaries an application
must preserve when it adopts PayOps.

`verifyIntentFromFixture` replaces the fixture's embedded expectation with the
application's own payment intent. It then requires mainnet, the legacy SPL Token
Program, the exact mint, recipient owner, destination token account, base-unit
amount, reference, and finalized commitment. The example supports canonical
mainnet USDC and USDT; it never treats a merely confirmed observation as paid.

`createReferenceWebhookReceiver` verifies the HMAC over the exact raw request
bytes before parsing JSON. It accepts only a schema-valid `invoice.paid` event
whose body ID matches the request header. A PostgreSQL transaction reserves the
event ID and inserts the paid-invoice side effect together, so sequential or
concurrent delivery retries apply the effect once. Reusing an event ID with
different signed bytes is rejected.

The example stores no private key and cannot move merchant funds. Production
applications should place the same logic behind their HTTP framework, source
webhook secrets from a secret manager, use TLS, and retain their own audit and
authorization controls.

Run it against the repository's disposable PostgreSQL database:

```bash
docker compose -f packages/ingestion/docker-compose.test.yml up -d
DATABASE_URL=postgres://payops:payops@127.0.0.1:55432/payops_test \
  pnpm --dir examples/reference-integration test
```
