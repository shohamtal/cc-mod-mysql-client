# Demo database

Dummy data for trying the console and for the README screenshots. Nothing here is real.

```
docker create --name sqlc-demo -p 127.0.0.1:3307:3306 -e MYSQL_ROOT_PASSWORD=root-demo mysql:8.4
docker cp seed.sql sqlc-demo:/docker-entrypoint-initdb.d/seed.sql
docker start sqlc-demo
SQL_DEMO_PASSWORD=demo-only-password claude
```

Then in Claude Code: `/sql --configfilepath <path to this folder>/servers.json`. The staging and production entries point at example hosts that don't exist; they only fill the server menu.
