'use strict'

exports.config = {
  app_name: ['Workwise Server Monitoring'],
  license_key: process.env.NEWRELIC_LICENSE_KEY,
  logging: {
    level: 'info'
  },
  allow_all_headers: true,
  attributes: {
    enabled: true
  }
}