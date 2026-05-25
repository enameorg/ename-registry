-- Runs once, on first boot of the postgres container, against ename_dev (the
-- database created by POSTGRES_DB). The CREATE DATABASE below establishes the
-- second logical database used by the test runner. Both share the same cluster.

CREATE DATABASE ename_test;
