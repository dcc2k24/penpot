# Sandbox threads

The sandbox runs guest code on the Node main thread, through QuickJS with asyncify. The CPU budget and the wall-clock limit stop a script that runs too long. A script still shares the event loop with the server while it runs, so a slow script can delay other requests.

The planned follow-up is a worker_threads pool, with one worker per sandbox session. Each worker has its own event loop, so a script no longer blocks the server.

Until then, the limits stay as they are.
