variable "azure_subscription_id" {
  description = "BJFC's subscription (az account show --query id -o tsv)"
  type        = string
}
variable "resource_group" {
  description = "Created by Datalink IT; Steven has Contributor + RBAC Administrator on it only"
  type        = string
  default     = "rg-bjfc-commandcentre"
}
variable "webapp_name" {
  description = "Globally unique; becomes <name>.azurewebsites.net"
  type        = string
  default     = "bjfc-commandcentre"
}
variable "key_vault_name" {
  description = "Globally unique, 3-24 chars"
  type        = string
  default     = "kv-bjfc-commandcentre"
}
variable "sku" {
  type    = string
  default = "B1" # no slots needed: staging stays on the RunCloud VPS
}
variable "node_version" {
  type    = string
  default = "24-lts"
}
variable "custom_domain" {
  description = "Added to ALLOWED_HOSTS now; bound to the app once BJFC's DNS records exist"
  type        = string
  default     = "command.bjfc.co.za"
}
variable "admin_email" {
  type    = string
  default = "admin@bjfc.co.za"
}
