locals {
  signing_services = toset(["control-api", "voice-runtime", "workflow-worker", "connector-worker", "document-worker", "eval-runner"])
  service_key_ids  = { for service in local.signing_services : service => "${service}-${var.environment}-${var.service_key_generation}" }
  spki_base64 = {
    for service in local.signing_services : service => replace(
      replace(
        replace(tls_private_key.service[service].public_key_pem, "-----BEGIN PUBLIC KEY-----", ""),
        "-----END PUBLIC KEY-----",
        "",
      ),
      "\n",
      "",
    )
  }
  service_jwks = jsonencode({
    keys = [
      for service in sort(tolist(local.signing_services)) : {
        kty = "OKP"
        crv = "Ed25519"
        alg = "EdDSA"
        use = "sig"
        kid = local.service_key_ids[service]
        x   = replace(replace(trimsuffix(substr(local.spki_base64[service], 16, 44), "="), "+", "-"), "/", "_")
      }
    ]
  })
}

resource "tls_private_key" "service" {
  for_each  = local.signing_services
  algorithm = "ED25519"
}

resource "aws_secretsmanager_secret_version" "service_key" {
  for_each      = local.signing_services
  secret_id     = module.secrets.ids["service-keys/${each.key}"]
  secret_string = tls_private_key.service[each.key].private_key_pem
}

resource "aws_secretsmanager_secret_version" "service_jwks" {
  secret_id     = module.secrets.ids["service-jwks"]
  secret_string = local.service_jwks
}

resource "random_bytes" "application_key" {
  for_each = toset(["cursor/signing-key", "api-keys/pepper", "oauth/state-key", "session-signing-key"])
  length   = 32
}

resource "aws_secretsmanager_secret_version" "application_key" {
  for_each      = random_bytes.application_key
  secret_id     = module.secrets.ids[each.key]
  secret_string = each.value.base64
}
