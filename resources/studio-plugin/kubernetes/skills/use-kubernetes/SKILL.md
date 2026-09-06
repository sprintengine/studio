---
name: use-kubernetes
description: Diagnose and operate a Kubernetes or OpenShift cluster through the kubeconfig this machine already has — pods, logs, events, any resource kind, scaling, exec and Helm. Use when asked why a deployment is unhealthy or a pod is restarting, to read logs or events from a cluster, to list or fetch any Kubernetes object, to scale, apply, restart or delete something, to run a command inside a pod, or when a cluster tool you expected is missing and you need to know whether that is the cluster or the server's configuration.
---

# Kubernetes

This server talks to whatever the kubeconfig on this machine points at, with
that file's credentials and that identity's permissions. It is not a sandbox.
Every write below happens to a real cluster, and several of them cannot be
undone.

## Know where you are before you touch anything

`configuration_contexts_list` names the contexts and their server URLs, and
`configuration_view` returns the kubeconfig itself. Read one of them first.
"Production" and "staging" look identical from inside a tool call, and the
current context is whatever the person last ran `kubectl config use-context`
against — not necessarily the cluster they are asking about.

Multi-cluster support is on by default, and when the kubeconfig holds more than
one cluster **every applicable tool takes an extra `context` argument**. Pass it
explicitly once you know which cluster is meant. Omitting it is not an error;
it silently means "the current one", which is the failure mode this paragraph
exists to prevent.

`namespaces_list` (or `projects_list` on OpenShift) is the other half of your
bearings. A namespace argument is optional almost everywhere and defaults to
the configured one.

## Diagnose before you change

The order that answers "why is this broken" fastest:

1. `events_list` — warnings and state changes, cluster-wide or for one
   namespace. `fieldSelector: "type=Warning"` cuts it to what went wrong.
   Events expire (an hour by default), so an empty list means "nothing
   recently", never "nothing ever".
2. `pods_list_in_namespace` with a `labelSelector` for the workload, or
   `pods_list` across all namespaces. **CrashLoopBackOff cannot be filtered
   for**: it is a container state, not a pod phase, and `status.phase` only
   takes Pending, Running, Succeeded, Failed and Unknown. Filter to `Running`
   and read the restart counts instead.
3. `pods_log` with `tail`, and with `previous: true` when the container has
   already restarted — the current container's log of a crash loop is the
   startup that has not failed yet, and the previous one is the crash.
4. `resources_get` on the Deployment, StatefulSet or Job behind the pod. The
   pod is usually the symptom; the controller's status carries the cause.

`pods_top` and `nodes_top` read the Metrics Server. On a cluster that does not
run one they fail, and that failure means "no metrics-server", not "no load".

## Changing things

`resources_create_or_update` is **Server-Side Apply with the full desired
state, not a patch**. Any field this tool set on a previous call that your new
manifest omits is removed. To edit something that exists: `resources_get` it,
change the one field, and re-apply the whole object. Sending a fragment because
it is the part you care about is how a Deployment loses its resource limits.

`resources_scale` both reads and writes: called without `scale` it reports the
current replica count, called with one it changes it. Read first.

`pods_delete` and `resources_delete` are immediate and permanent. A pod under a
controller is recreated, which is what makes deleting one a legitimate restart;
a resource that nothing owns is simply gone. Say which of the two you are doing
before you do it, and never delete to "clean up" something you were only asked
to look at.

`pods_exec` runs a command inside a container with that pod's service account,
and `pods_run` starts a new pod from an image. Both are arbitrary execution on
the cluster. Use them to observe — `ls`, `cat`, a health endpoint — and treat
anything that writes as a change that needs asking about first.

## When a tool you expected is not there

Only two toolsets are enabled by default: `config` and `core`. `helm`, `kcp`,
`kiali`, `kubevirt`, `netobserv` and `tekton` are off unless the server was
started with `--toolsets` naming them. So a missing `helm_install` is the
server's configuration, not a cluster without Helm — say so and let the person
widen the toolset list, rather than reaching for `pods_run` to do it by hand.

The same file that sets toolsets can set `--read-only` (no writes at all) or
`--disable-destructive` (no deletes or updates), and can deny whole resource
kinds — `Secret` is the usual one. A refusal that names a denied resource is
the cluster's owner having decided, and is not something to route around. For a
workspace that must never change a cluster, adding `--read-only` to the args in
this plugin's `.mcp.json` is the honest way to guarantee it.

## Reporting

Report what the cluster said, with the namespace and context you read it in. An
answer that does not name the cluster it came from is unverifiable, and on a
kubeconfig with four contexts it is also probably about the wrong one.
