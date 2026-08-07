# TEST ONLY TLS fixture

The certificate and private key in this directory identify only
`receiver.test` for the loopback HTTPS integration test. They are public test
material, must never be used outside tests, and are excluded from the package
artifact by `package.json`'s explicit `files` allowlist.
