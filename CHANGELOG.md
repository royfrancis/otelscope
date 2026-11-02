# Versions

A summary of changes in recent releases.

## 1.0.2

- 02-Nov-2026
- Logger
  - Supports Positron
  - Refuses to start if two listeners have the same name or folder
  - OTLP/HTTP requests: accepts deflate as well as gzip, and protobuf or JSON bodies whose Content-Type is missing or wrong
  - Error replies are a Status message, in protobuf if the request says protobuf and in JSON otherwise
- Site
  - The Other tab is always last

## 1.0.1

- 01-Nov-2026
- Site
  - Selections persist until the page is reloaded, when switching between usage and logs or between tools
    - Usage: y-axis, color, time range (preset, calendar or zoom and slider), session and table view
    - Logs: event, search, columns and page
  - Version number shown in the navbar

## 1.0.0

- 31-Oct-2026
- First release
- Logger
  - Supports Claude code, VS Code GitHub Copilot and Opencode
  - Support forwarding logs to other services
- Site
  - Displays usage and logs
  - Usage has interactive bar plot and table view
  - Dropdowns for y-axis, color
  - Filters for date and sessions