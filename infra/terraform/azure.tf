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

# Steven's "Key Vault Secrets Officer" on this vault was assigned by Datalink IT (2026-11-12), outside
# Terraform: his RBAC Administrator role may only grant "Key Vault Secrets User" (ABAC condition).

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
    # Real SharePoint data is connected (BJFC Consulting site): hide the demo folders, simulated
    # servers and demo SharePoint site. Remove this line to bring the demo back.
    DEMO_DATA = "off"
    # The BJFC Consulting site lists its Admin and Projects folders by name (about 35,000 files,
    # read from SharePoint on demand); the default cap is 5,000. Raise further before adding
    # "BJFC Projects/DoT KZN" (98,000 files) — and move to a bigger plan first (see docs/HANDOFF.md).
    SHAREPOINT_MAX_FILES = "60000"
    # Microsoft sign-in + SharePoint: app registration "BJFC Command Centre" (owned by Datalink).
    ENTRA_TENANT_ID = "e1ec689f-56b4-4ede-8ff1-5cf9776b2fa8"
    ENTRA_CLIENT_ID = "5a314e37-4861-48de-a66b-6e15014fc4cc"
  }
  # The secrets (ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_PASSWORD, ENTRA_CLIENT_SECRET) are set
  # outside Terraform, never in this file (S5). They are Key Vault references to the secrets
  # anthropic-api-key, session-secret, admin-password and BJFC-CC-Key (the client secret Datalink
  # created, credential "BJFC_CC_Secret", expires 2028-11-17) in kv-bjfc-commandcentre, set with az.
  lifecycle {
    ignore_changes = [
      app_settings["ANTHROPIC_API_KEY"],
      app_settings["SESSION_SECRET"],
      app_settings["ADMIN_PASSWORD"],
      app_settings["ENTRA_CLIENT_SECRET"],
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
