# Questions for David — making BilboMD self-service on B21

**Context.** The BilboMD web app (UI + backend + Mongo + Redis + Carbonara/AutoMD-SAXS
worker) is deployed and working in the `b21-beamline` namespace. Today it's reached via
`kubectl port-forward` and login is a hand-injected one-time code in Mongo — fine for us
testing, but not usable by a scientist who just wants to run a job. Two things need to
change to make it self-service: **(2) a real URL to reach the UI**, and **(3) a real way
to log in**. These questions cover both. Nothing here is urgent — it's for whenever the
next chat happens.

---

## Topic 2 — Access: replace port-forward with a real URL (Ingress / LoadBalancer)

Goal: a scientist opens `https://<something>.diamond.ac.uk` in a browser — no kubectl,
no port-forward. (The namespace quota shows `services.loadbalancers: 6/25` already in use,
so LoadBalancer-type Services are clearly available here.)

1. **Ingress vs LoadBalancer** — Does `b21-beamline` have an **ingress controller** we
   should target (nginx-ingress? Traefik?), or is the house style to expose each service
   via its own **LoadBalancer Service** like the existing B21 services? Which do you
   prefer we use for the BilboMD UI?

2. **DNS hostname** — Can we get a **DNS name** pointed at the cluster for this
   (e.g. `bilbomd-b21.diamond.ac.uk`)? Who requests it / how long does that take?

3. **TLS certificate** — For HTTPS on that hostname, is there **cert-manager** in the
   cluster we can use (Let's Encrypt / an internal issuer), or is there a Diamond-issued
   certificate process we should follow instead?

4. **Anything internal-only?** — Should this be reachable only from the Diamond network,
   or also externally? (Affects whether we need auth in front and which ingress class.)

> Once we have a hostname we set `BILBOMD_URL` to it in the config. That also fixes CORS
> properly (we can drop the current `localhost:8080` dev exception) and makes the login
> cookie `secure` over real HTTPS.

---

## Topic 3 — Login: let users authenticate themselves

Goal: remove the "inject an OTP into Mongo" shortcut. BilboMD has two native login paths;
we'd like to pick one (or both). Both depend on the hostname from Topic 2.

5. **ORCID (our preferred option)** — BilboMD supports ORCID OAuth login, which fits our
   audience (scientists have ORCIDs). To enable it we need to **register an ORCID
   application** and get a client id/secret, and register the **redirect URI**
   (`https://<hostname>/api/v1/auth/orcid/callback`). Is there a **Diamond-institutional
   ORCID app** we should register under, or do we create our own?

6. **Email magic-link (alternative/additional)** — The other path emails a login link.
   For that we need an **SMTP relay**. Is there a **Diamond SMTP server** we can send
   through from inside the cluster (host/port, and does it need auth or an allowlisted
   sender address)?

7. **Preference** — Given the above, do you have a recommendation between ORCID and email
   for B21 users? (We lean ORCID; email is a good fallback / for non-ORCID users.)

---

## Summary of what we need from you

| # | Decision / resource | Blocks |
|---|--------------------|--------|
| 1 | Ingress controller vs LoadBalancer (house style) | UI URL |
| 2 | DNS hostname for the UI | UI URL |
| 3 | TLS cert approach (cert-manager vs Diamond cert) | HTTPS |
| 4 | Internal-only vs external reachability | ingress class / auth |
| 5 | ORCID app (institutional vs our own) + client id/secret | ORCID login |
| 6 | Diamond SMTP relay details | email login |
| 7 | Recommended login method for B21 | which of 5/6 to build first |
