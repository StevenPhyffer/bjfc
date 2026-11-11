terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
  # I3: state never in git. Local state lives in the Vault.
  backend "local" {
    path = "/Volumes/MacD/Vault/bjfc/terraform/terraform.tfstate"
  }
}

# Auth: `az login --tenant <BJFC tenant>` (Steven is a guest there). No keys in files.
provider "azurerm" {
  features {}
  subscription_id                 = var.azure_subscription_id
  resource_provider_registrations = "none" # Contributor on one resource group can't register providers
}
