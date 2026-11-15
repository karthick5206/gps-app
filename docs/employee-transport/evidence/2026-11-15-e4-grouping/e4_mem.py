import json, subprocess, sys, time, psutil
sys.path.insert(0, sys.argv[2]); import e4_scale as E
for n, fleet in ((75, [7]*17), (75, [7]*20)):
    p = E.build(n, fleet, None); p['options']['timeLimitS'] = 10
    proc = subprocess.Popen([sys.executable, '-c', E.CHILD, sys.argv[1] + '/services/routing-optimizer'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    root = psutil.Process(proc.pid); proc.stdin.write(json.dumps(p)); proc.stdin.close(); peak = 0
    while proc.poll() is None:
        try: peak = max(peak, sum(c.memory_info().rss for c in [root] + root.children(recursive=True)))
        except psutil.Error: pass
        time.sleep(0.05)
    print(n, len(fleet), 'vehicles: peak RSS (process tree) MB =', round(peak / 2**20), proc.stdout.read().strip()[:120])
