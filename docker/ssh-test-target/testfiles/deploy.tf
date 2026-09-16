resource "null_resource" "fixture" {
  triggers = {
    purpose = "omnyssh sftp/editor test fixture"
  }
}
