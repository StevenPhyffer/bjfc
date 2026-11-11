# target: azure-webapp (production only). The resource group already exists — Datalink IT made it,
# and Steven's Contributor role is scoped to it, so it's read here, not created.
data "azurerm_resource_group" "this" {
  name = var.resource_group
}
data "azurerm_client_config" "me" {}

resource "azurerm_service_plan" "this" {
  name                = "plan-${var.webapp_name}"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = var.sku
}

# Secrets (S5): the vault holds them, the app reads them through its managed identity.
# Values are set by hand with `az keyvault secret set` (see docs/HANDOFF.md), never in Terraform.
resource "azurerm_key_vault" "this" {
  name                       = var.key_vault_name
  resource_group_name        = data.azurerm_resource_group.this.name
  location                   = data.azurerm_resource_group.this.location
  tenant_id                  = data.azurerm_client_config.me.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
}

# Writing secrets into the vault needs "Key Vault Secrets Officer" for Steven. His RBAC Administrator
# role is limited (ABAC condition) to granting "Key Vault Secrets User" only, so Datalink IT has to
# assign that one. Until then the three secrets live in App Settings (see lifecycle below).

resource "azurerm_linux_web_app" "this" {
  name                = var.webapp_name
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  service_plan_id     = azurerm_service_plan.this.id
  https_only          = true

  # Deploys authenticate with Entra ID (az login), not publishing passwords.
  webdeploy_publish_basic_authentication_enabled = false
  ftp_publish_basic_authentication_enabled       = false

  identity { type = "SystemAssigned" }

  site_config {
    application_stack { node_version = var.node_version }
    app_command_line                  = "node server.js"
    always_on                         = true
    ftps_state                        = "Disabled"
    minimum_tls_version               = "1.2"
    health_check_path                 = "/login.html"
    health_check_eviction_time_in_min = 10
  }

  # Non-secret settings and Key Vault references only — no secret values here.
  app_settings = {
    SCM_DO_BUILD_DURING_DEPLOYMENT = "true"
    HOST                           = "0.0.0.0"
    PUBLIC_MODE                    = "1"
    ALLOWED_HOSTS                  = "${var.webapp_name}.azurewebsites.net,${var.custom_domain}"
    DATA_DIR                       = "/home/data"
    ENV_FILE                       = "/home/data/.env"
    SOURCES_ROOT                   = "/home/site/wwwroot/demo-data"
    ADMIN_EMAIL                    = var.admin_email
    ADMIN_NAME                     = "Director"
  }
  # The secrets (ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_PASSWORD) are set outside Terraform, never
  # in this file (S5): App Settings for now, later Key Vault references to the secrets
  # anthropic-api-key, session-secret and admin-password in kv-bjfc-commandcentre.
  lifecycle {
    ignore_changes = [
      app_settings["ANTHROPIC_API_KEY"],
      app_settings["SESSION_SECRET"],
      app_settings["ADMIN_PASSWORD"],
    ]
  }

  logs {
    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }
}

# The app may read secrets, nothing else.
resource "azurerm_role_assignment" "app_secrets_user" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_web_app.this.identity[0].principal_id
}

output "app_host" { value = azurerm_linux_web_app.this.default_hostname }
output "custom_domain_verification_id" {
  description = "Value of the asuid TXT record BJFC's DNS needs"
  value       = azurerm_linux_web_app.this.custom_domain_verification_id
  sensitive   = true
}
output "key_vault" { value = azurerm_key_vault.this.name }
