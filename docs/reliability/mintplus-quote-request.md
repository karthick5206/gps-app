# Quote request to Mintplus (draft for the owner to send)

> **Subject:** Quote: small Linux VM in the same data centre as 166.0.242.121, with a private network
>
> Hello,
>
> We run our Windows server **166.0.242.121** with you. We would like a quote for one additional Linux VM in the **same data centre**:
>
> - 2 vCPU, 2 GB RAM, 20–40 GB SSD
> - Ubuntu Server 24.04 LTS (64-bit), root/sudo access by SSH key
> - A **private network (VLAN) between this VM and 166.0.242.121**. Traffic between the two must stay on that private network.
> - One public IPv4 for administration, filtered to our addresses. Optional if you provide console or VPN access instead.
> - Monthly billing
>
> Please tell us:
> 1. The monthly price in INR, plus any setup fee, and whether GST is extra.
> 2. Whether the private network is **dedicated to our two machines**, or shared with other customers. Can traffic on it be seen by anyone else?
> 3. The private IP addresses we would get on both machines, and the expected latency between them.
> 4. Whether you offer a provider-side firewall and snapshots or backups for the VM, and at what cost.
> 5. The lead time for provisioning.
>
> The VM will run a database cache (Valkey) used only by our application on 166.0.242.121.
>
> Thank you,
> Karthick Ramasamy

Notes for the owner (not part of the e-mail):
- **Question 2 decides whether we need TLS** (runbook variant A or B). Ask for the answer in writing.
- **Sizing:** 2 GB is enough. See [valkey-sizing.md](valkey-sizing.md).
  - Measured: 458 B per GT06 stream entry, so the full 2,000,000-entry stream is about 874 MB.
  - Gateway backpressure starts at 1.6 M entries, about 700 MB.
  - Live state is 1.4 KB per vehicle.
  - That fits `maxmemory 1gb` on a 2 GB VM.
- **Reference prices** (9 Nov 2026, excluding GST): AWS Lightsail Mumbai 2 GB ≈ ₹1,125/month; DigitalOcean 1 vCPU / 2 GB ≈ ₹1,125. Details in [cache-assessment.md §6](cache-assessment.md).
