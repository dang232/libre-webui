---
sidebar_position: 25
title: 'Hardware Requirements'
description: 'Hardware guidance for Alcore, provider-backed models, and container-backed Work tasks.'
slug: /HARDWARE_REQUIREMENTS
keywords:
  [
    hardware requirements,
    server sizing,
    docker resources,
    work runtime capacity,
  ]
---

# Hardware Requirements

Alcore's normal Chat interface is lightweight: model inference happens at
your configured providers, not on the host. Most resource demand comes from
the backend, the database, and container-backed Work tasks, which add a
separate CPU, memory, process, image, and project-storage budget.

## Quick Reference

Alcore itself needs only a modest server: Node.js 22+, a few GB of RAM,
and disk for the database, uploads, and Work volumes. Model inference
runs at your providers, so host GPUs are unnecessary — budget CPU and
memory for concurrent Work task containers instead (see below).

## Work Runtime Capacity

Each active task container defaults to:

- 2 GB of memory;
- 2 CPUs; and
- 256 processes.

The backend allows two active container-backed tasks across the instance and one
per administrator by default. These are limits, not reservations, but operators
should budget for the Alcore backend, browser, Docker, and task containers
at the same time.

Using a remote model plugin avoids loading anything large locally. It does not
remove the Docker requirement or the resources needed by the Work container.

Every Work task also owns a Docker named volume for generated files and local
dependencies. Volumes do not currently have per-task disk quotas, so package
installs or generated projects can exhaust Docker storage. Monitor the Docker
data root, set host-level limits where available, and back up task volumes
you care about.
