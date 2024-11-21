import { fork } from 'node:child_process';

fork('./scripts/server.mjs', {
    env: {
        ...process.env,
        SERVER_DIR: 'build/',
        SERVER_PORT: '8383',
    },
});