locals {
  config_script = "<script>window.__APP_CONFIG__ = ${jsonencode({
    cognitoDomain = var.cognito_hosted_ui_base_url
    webClientId   = var.cognito_web_client_id
    httpApi       = var.http_api_endpoint
    wsApi         = var.websocket_api_endpoint
    region        = var.aws_region
  })};</script>"

  index_html = replace(
    file("${path.module}/../../../frontend/index.html"),
    "</head>",
    "${local.config_script}</head>"
  )
}

resource "aws_s3_object" "index_html" {
  bucket       = var.frontend_bucket_name
  key          = "index.html"
  content      = local.index_html
  content_type = "text/html"
  etag         = md5(local.index_html)
}

resource "null_resource" "invalidate_frontend" {
  triggers = {
    index_html_etag = aws_s3_object.index_html.etag
  }

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id ${var.cloudfront_distribution_id} --paths /index.html"
  }
}
