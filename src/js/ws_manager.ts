import { remote } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import childProcess from 'child_process';
import * as log from 'electron-log';
import Store from 'electron-store';

import { config } from './ws_config';
import { WalletShellSession } from './ws_session';
import { WalletShellApi, WalletShellSettings } from './ws_api';
import  { UpdateUiState } from './wsui_updater';
import { Utils } from './ws_utils';
import { syncStatus } from './ws_constants';
import { WalletBackend, ConventionalDaemon, BlockchainCacheApi } from 'turtlecoin-wallet-backend';
import { resolve } from 'dns';

let daemon: ConventionalDaemon | BlockchainCacheApi = new BlockchainCacheApi('blockapi.turtlepay.io', true);
let wallet: any;

const wsutil = new Utils();
const settings = new Store({ name: 'Settings' });
const sessConfig = { debug: (remote as any).app.debug, walletConfig: (remote as any).app.walletConfig };
const wsession = new WalletShellSession(sessConfig);
const uiupdater = new UpdateUiState();

const SERVICE_LOG_DEBUG = wsession.get('debug');
const SERVICE_LOG_LEVEL_DEFAULT = 0;
const SERVICE_LOG_LEVEL_DEBUG = 5;
const SERVICE_LOG_LEVEL = (SERVICE_LOG_DEBUG ? SERVICE_LOG_LEVEL_DEBUG : SERVICE_LOG_LEVEL_DEFAULT);
const SERVICE_MIN_LISTEN_PORT = 10101;

const ERROR_WALLET_EXEC = `Failed to start ${config.walletServiceBinaryFilename}. Set the path to ${config.walletServiceBinaryFilename} properly in the settings tab.`;
const ERROR_WALLET_PASSWORD = 'Failed to load your wallet, please check your password';
const ERROR_WALLET_IMPORT = 'Import failed, please check that you have entered all information correctly';
const ERROR_WALLET_CREATE = 'Wallet can not be created, please check your input and try again';
const ERROR_RPC_TIMEOUT = 'Unable to communicate with selected node, please try again in a few seconds or switch to another node address';
const INFO_FUSION_DONE = 'Wallet optimization completed, your balance may appear incorrect for a while.';
const INFO_FUSION_SKIPPED = 'Wallet already optimized. No further optimization is needed.';
const ERROR_FUSION_FAILED = 'Unable to optimize your wallet, please try again in a few seconds';

interface Options {
    daemonHost: any;
    daemonPort: any;
    serviceProcess: any;
    serviceBin: any;
    servicePassword: any;
    serviceHost: any;
    servicePort: any;
    serviceTimeout: any;
    serviceArgsDefault: any[];
    walletConfigDefault: { 'rpc-password': any; };
    servicePid: any;
    serviceLastPid: any;
    serviceActiveArgs: any[];
    serviceApi: any;
    syncWorker: any;
    fusionTxHash: any[];
}

export class WalletShellManager {

    public nodeAddress = settings.get('node_address').split(':');
    daemonHost: any;
    daemonPort: any;
    serviceProcess: any;
    serviceBin: any;
    servicePassword: any;
    serviceHost: any;
    servicePort: any;
    serviceTimeout: any;
    serviceArgsDefault: any[];
    walletConfigDefault: { 'rpc-password': any; };
    servicePid: any;
    serviceLastPid: any;
    serviceActiveArgs: any[];
    serviceApi: any;
    syncWorker: any;
    fusionTxHash: any[];

    constructor(opts?: Options) {
        this.daemonHost = this.nodeAddress[0] || null;
        this.daemonPort = this.nodeAddress[1] || null;
        this.serviceProcess = null;
        this.serviceBin = settings.get('service_bin');
        this.servicePassword = settings.get('service_password');
        this.serviceHost = settings.get('service_host');
        this.servicePort = settings.get('service_port');
        this.serviceTimeout = settings.get('service_timeout');
        this.serviceArgsDefault = ['--rpc-password', settings.get('service_password')];
        this.walletConfigDefault = { 'rpc-password': settings.get('service_password') };
        this.servicePid = null;
        this.serviceLastPid = null;
        this.serviceActiveArgs = [];
        this.serviceApi = null;
        this.syncWorker = null;
        this.fusionTxHash = [];
    }


    public getUnusedPort() {
        let port = SERVICE_MIN_LISTEN_PORT;
        const server = net.createServer();
        return new Promise((resolve, reject) => server
            .on('error', error => (error as any).code === 'EADDRINUSE' ? server.listen(++port) : reject(error))
            .on('listening', () => server.close(() => resolve(port)))
            .listen(port));
    };

    public init() {
        this._getSettings();
        if (this.serviceApi !== null) return;

        this.getUnusedPort().then(port => {
            console.log(`${port} is available`);
            this.servicePort = port;
            let cfg: WalletShellSettings = {
                service_host: this.serviceHost,
                service_port: this.servicePort,
                service_password: this.servicePassword,
                minimum_fee: (config.minimumFee * config.decimalDivisor).toString(),
                anonymity: config.defaultMixin.toString(),
            };
            this.serviceApi = new WalletShellApi(cfg);
        }).catch((err) => {
            log.error("Unable to find a port to listen to, please check your firewall settings");
            log.error(err.message);
        });
    };

    public _getSettings() {
        let nodeAddress = settings.get('node_address').split(':');
        this.daemonHost = nodeAddress[0] || null;
        this.daemonPort = nodeAddress[1] || null;
        this.serviceBin = settings.get('service_bin');
    };

    public _reinitSession() {
        this._wipeConfig();
        wsession.reset();
        this.notifyUpdate({
            type: 'sectionChanged',
            data: 'reset-oy'
        });
    };

    public _serviceBinExists() {
        wsutil.isFileExist(this.serviceBin);
    };

    // check 
    public serviceStatus() {
        return (undefined !== this.serviceProcess && null !== this.serviceProcess);
    };

    public isRunning() {
        this.init();
        let proc = path.basename(this.serviceBin);
        let platform = process.platform;
        let cmd = '';
        switch (platform) {
            case 'win32': cmd = `tasklist`; break;
            case 'darwin': cmd = `ps -ax | grep ${proc}`; break;
            case 'linux': cmd = `ps -A`; break;
            default: break;
        }
        if (cmd === '' || proc === '') return false;

        childProcess.exec(cmd, (err, stdout, stderr) => {
            if (err) log.debug(err.message);
            if (stderr) log.debug(stderr.toLocaleLowerCase());
            let found = stdout.toLowerCase().indexOf(proc.toLowerCase()) > -1;
            log.debug(`Process found: ${found}`);
            return found;
        });
    };

    public _writeIniConfig(cfg) {
        let configFile = wsession.get('walletConfig');
        if (!configFile) return '';

        try {
            fs.writeFileSync(configFile, cfg);
            return configFile;
        } catch (err) {
            log.error(err);
            return '';
        }
    };

    public _writeConfig(cfg) {
        let configFile = wsession.get('walletConfig');
        if (!configFile) return '';

        cfg = cfg || {};
        if (!cfg) return '';

        let configData = '';
        Object.keys(cfg).map((k) => { configData += `${k}=${cfg[k]}${os.EOL}`; });
        try {
            fs.writeFileSync(configFile, configData);
            return configFile;
        } catch (err) {
            log.error(err);
            return '';
        }
    };

    public _wipeConfig() {
        try { fs.unlinkSync(wsession.get('walletConfig')); } catch (e) { }
    };
    
    public startWallet(walletFile, password, onError, onSuccess, walletSession) {
        log.debug('walletfile: ' + walletFile);
        log.debug('password: ' + password);
        if (this.syncWorker) this.stopSyncWorker();
        const [wallet, error] = WalletBackend.openWalletFromFile(daemon, walletFile, password);
        if (error) {
            log.debug(error);
            onError(`ERROR_WALLET_EXEC: ${error}`);
        } else {
            walletSession.wallet = wallet;
            let walletAddress = wallet.getPrimaryAddress();
            wallet.start();
            log.debug('Opened wallet ' + walletAddress)
            wsession.set('loadedWalletAddress', walletAddress);
            onSuccess();
        }
    }

    public _argsToIni(args) {
        let configData = "";
        if ("object" !== typeof args || !args.length) return configData;
        args.forEach((k, v) => {
            let sep = ((v % 2) === 0) ? os.EOL : "=";
            configData += `${sep}${k.toString().replace('--', '')}`;
        });
        return configData.trim();
    };

    public stopWallet(fileName: string, password: string, wallet) {
        return new Promise(function (resolve) {
            log.debug('Saving and closing wallet...');
            wallet.saveWalletToFile(fileName, password);
            resolve(true);
        });
    };

    public stopService() {
        log.debug('stopping service');
        this.init();
        let wsm = this;
        return new Promise(function (resolve) {
            if (wsm.serviceStatus()) {
                log.debug("Service is running");
                wsm.serviceLastPid = wsm.serviceProcess.pid;
                wsm.stopSyncWorker();
                wsm.serviceApi.save().then(() => {
                    log.debug('saving wallet');
                    try {
                        wsm.terminateService(true);
                        wsm._reinitSession();
                        resolve(true);
                    } catch (err) {
                        log.debug(`SIGTERM failed: ${err.message}`);
                        wsm.terminateService(true);
                        wsm._reinitSession();
                        resolve(false);
                    }
                }).catch((err) => {
                    log.debug(`Failed to save wallet: ${err.message}`);
                    // try to wait for save to completed before force killing
                    setTimeout(() => {
                        wsm.terminateService(true); // force kill
                        wsm._reinitSession();
                        resolve(true);
                    }, 8000);
                });
            } else {
                log.debug("Service is not running");
                wsm._reinitSession();
                resolve(true);
            }
        });
    };

    public terminateService(force?: boolean) {
        if (!this.serviceStatus()) return;
        force = force || false;
        let signal = force ? 'SIGKILL' : 'SIGTERM';
        // ugly!
        this.serviceLastPid = this.servicePid;
        try {
            this.serviceProcess.kill(signal);
            if (this.servicePid) process.kill(this.servicePid, signal);
        } catch (e) {
            if (!force && this.serviceProcess) {
                log.debug(`SIGKILLing ${config.walletServiceBinaryFilename}`);
                try { this.serviceProcess.kill('SIGKILL'); } catch (err) { }
                if (this.servicePid) {
                    try { process.kill(this.servicePid, 'SIGKILL'); } catch (err) { }
                }
            }
        }

        this.serviceProcess = null;
        this.servicePid = null;
    };

    public startSyncWorker() {
        this.init();
        let wsm = this;
        if (this.syncWorker !== null) {
            this.syncWorker = null;
            try { wsm.syncWorker.kill('SIGKILL'); } catch (e) { }
        }

        this.syncWorker = childProcess.fork(
            path.join(__dirname, './ws_syncworker.js')
        );

        this.syncWorker.on('message', (msg) => {
            if (msg.type === 'serviceStatus') {
                wsm.syncWorker.send({
                    type: 'start',
                    data: {}
                });
                wsession.set('serviceReady', true);
                wsession.set('syncStarted', true);
            } else {
                wsm.notifyUpdate(msg);
            }
        });

        this.syncWorker.on('close', function () {
            wsm.syncWorker = null;
            try { wsm.syncWorker.kill('SIGKILL'); } catch (e) { }
            log.debug(`service worker terminated.`);
        });

        this.syncWorker.on('exit', function () {
            wsm.syncWorker = null;
            log.debug(`service worker exited.`);
        });

        this.syncWorker.on('error', function (err) {
            try { wsm.syncWorker.kill('SIGKILL'); } catch (e) { }
            wsm.syncWorker = null;
            log.debug(`service worker error: ${err.message}`);
        });

        let cfgData = {
            type: 'cfg',
            data: {
                service_host: this.serviceHost,
                service_port: this.servicePort,
                service_password: this.servicePassword
            },
            debug: SERVICE_LOG_DEBUG
        };
        this.syncWorker.send(cfgData);
    };

    public stopSyncWorker() {
        log.debug('stopping syncworker');

        try {
            this.syncWorker.send({ type: 'stop', data: {} });
            this.syncWorker.kill('SIGTERM');
            this.syncWorker = null;
        } catch (e) {
            log.debug(`syncworker already stopped`);
        }
    };

    public getNodeFee() {
        let wsm = this;
        let [address, nodeFee] = daemon.nodeFee();
        if (nodeFee > 0) {
            nodeFee = nodeFee / config.decimalDivisor
        }
        wsession.set('nodeFee', nodeFee);
        if (nodeFee > 0 ) return nodeFee;
        wsm.notifyUpdate({
            type: 'nodeFeeUpdated',
            data: nodeFee
        });
        log.debug('nodeFee = ' + nodeFee);
        return nodeFee;
    }

    public genIntegratedAddress(paymentId, address) {
        let wsm = this;
        return new Promise((resolve, reject) => {
            address = address || wsession.get('loadedWalletAddress');
            let params = { address: address, paymentId: paymentId };
            wsm.serviceApi.createIntegratedAddress(params).then((result) => {
                return resolve(result);
            }).catch((err) => {
                return reject(err);
            });
        });
    };

    public createWallet(walletFile, password) {
        log.debug(walletFile, password);
        return new Promise((resolve, reject) => {
            const daemon: BlockchainCacheApi = new BlockchainCacheApi('blockapi.turtlepay.io', true);
            const wallet: WalletBackend = WalletBackend.createWallet(daemon);
            const saved = wallet.saveWalletToFile(walletFile, password);
            if (!saved) {
                log.error('ERROR_WALLET_CREATE')
                return reject(new Error(ERROR_WALLET_CREATE));
            }
            return resolve(walletFile);
        });
    };

    public importFromKeys(walletFile, password, viewKey, spendKey, scanHeight) {
        this.init();
        let wsm = this;
        return new Promise((resolve, reject) => {
            scanHeight = scanHeight || 0;

            let serviceArgs = wsm.serviceArgsDefault.concat([
                '-g', '-w', walletFile, '-p', password,
                '--view-key', viewKey, '--spend-key', spendKey,
                '--log-level', 0, '--log-file', path.join(remote.app.getPath('temp'), 'ts.log')
            ]);

            if (scanHeight >= 0) serviceArgs = serviceArgs.concat(['--scan-height', scanHeight]);

            childProcess.execFile(
                wsm.serviceBin, serviceArgs, (error, stdout, stderr) => {
                    if (stdout) log.debug(stdout);
                    if (stderr) log.debug(stderr);
                    if (error) {
                        log.debug(`Failed to import key: ${error.message}`);
                        return reject(new Error(ERROR_WALLET_IMPORT));
                    } else {
                        if (!wsutil.isRegularFileAndWritable(walletFile)) {
                            return reject(new Error(ERROR_WALLET_IMPORT));
                        }
                        return resolve(walletFile);
                    }
                }
            );
        });
    };

    public importFromSeed(walletFile, password, mnemonicSeed, scanHeight) {
        this.init();
        let wsm = this;
        return new Promise((resolve, reject) => {
            scanHeight = scanHeight || 0;

            let serviceArgs = wsm.serviceArgsDefault.concat([
                '-g', '-w', walletFile, '-p', password,
                '--mnemonic-seed', mnemonicSeed,
                '--log-level', 0, '--log-file', path.join(remote.app.getPath('temp'), 'ts.log')
            ]);

            if (scanHeight >= 0) serviceArgs = serviceArgs.concat(['--scan-height', scanHeight]);

            childProcess.execFile(
                wsm.serviceBin, serviceArgs, (error, stdout, stderr) => {
                    if (stdout) log.debug(stdout);
                    if (stderr) log.debug(stderr);

                    if (error) {
                        log.debug(`Error importing seed: ${error.message}`);
                        return reject(new Error(ERROR_WALLET_IMPORT));
                    } else {
                        if (!wsutil.isRegularFileAndWritable(walletFile)) {
                            return reject(new Error(ERROR_WALLET_IMPORT));
                        }
                        return resolve(walletFile);
                    }
                }
            );
        });
    };

    public getSecretKeys(address) {
        let wsm = this;
        return new Promise((resolve, reject) => {
            wsm.serviceApi.getBackupKeys({ address: address }).then((result) => {
                return resolve(result);
            }).catch((err) => {
                log.debug(`Failed to get keys: ${err.message}`);
                return reject(err);
            });
        });
    };

    public sendTransaction(params) {
        let wsm = this;
        return new Promise((resolve, reject) => {
            wsm.serviceApi.sendTransaction(params).then((result) => {
                return resolve(result);
            }).catch((err) => {
                return reject(err);
            });
        });
    };

    public rescanWallet(scanHeight) {
        let wsm = this;

        function resetSession() {
            wsession.set('walletUnlockedBalance', 0);
            wsession.set('walletLockedBalance', 0);
            wsession.set('synchronized', false);
            wsession.set('txList', []);
            wsession.set('txLen', 0);
            wsession.set('txLastHash', null);
            wsession.set('txLastTimestamp', null);
            wsession.set('txNew', []);
            let resetdata = {
                type: 'blockUpdated',
                data: {
                    blockCount: syncStatus.RESET,
                    displayBlockCount: syncStatus.RESET,
                    knownBlockCount: syncStatus.RESET,
                    displayKnownBlockCount: syncStatus.RESET,
                    syncPercent: syncStatus.RESET
                }
            };
            wsm.notifyUpdate(resetdata);
        }

        return new Promise((resolve) => {
            wsm.serviceApi.reset({ scanHeight: scanHeight }).then(() => {
                resetSession();
                return resolve(true);
            }).catch(() => {
                resetSession();
                return resolve(false);
            });
        });
    };

    private _fusionGetMinThreshold(threshold?: number, minThreshold?: number, maxFusionReadyCount?: number, counter?: number) {
        let wsm = this;
        return new Promise((resolve, reject) => {
            counter = counter || 0;
            threshold = threshold || (parseInt(wsession.get('walletUnlockedBalance'), 10) * 100) + 1;
            threshold = parseInt(threshold.toString(), 10);
            minThreshold = minThreshold || threshold;
            maxFusionReadyCount = maxFusionReadyCount || 0;

            let maxThreshCheckIter = 20;

            wsm.serviceApi.estimateFusion({ threshold: threshold }).then((res) => {
                // nothing to optimize
                if (counter === 0 && res.fusionReadyCount === 0) return resolve(0);
                // stop at maxThreshCheckIter or when threshold too low
                if (counter > maxThreshCheckIter || threshold < 10) return resolve(minThreshold);
                // we got a possibly best minThreshold
                if (res.fusionReadyCount < maxFusionReadyCount) {
                    return resolve(minThreshold);
                }
                // continue to find next best minThreshold
                maxFusionReadyCount = res.fusionReadyCount;
                minThreshold = threshold;
                threshold /= 2;
                counter += 1;
                resolve(wsm._fusionGetMinThreshold(threshold, minThreshold, maxFusionReadyCount, counter).then((res) => {
                    return res;
                }));
            }).catch((err) => {
                return reject(new Error(err));
            });
        });
    };

    private _fusionSendTx(threshold?: number, counter?: number) {
        let wsm = this;
        const wtime = ms => new Promise(resolve => setTimeout(resolve, ms));

        return new Promise((resolve, reject) => {
            counter = counter || 0;
            let maxIter = 256;
            if (counter >= maxIter) return resolve(wsm.fusionTxHash); // stop at max iter

            wtime(2400).then(() => {
                // keep sending fusion tx till it hit IOOR or reaching max iter 
                log.debug(`send fusion tx, iteration: ${counter}`);
                wsm.serviceApi.sendFusionTransaction({ threshold: threshold }).then((resp) => {
                    wsm.fusionTxHash.push(resp.transactionHash);
                    counter += 1;
                    return resolve(wsm._fusionSendTx(threshold, counter).then((resp) => {
                        return resp;
                    }));
                }).catch((err) => {
                    if (typeof err === 'string') {
                        if (!err.toLocaleLowerCase().includes('index is out of range')) {
                            log.debug(err);
                            return reject(new Error(err));
                        }
                    } else if (typeof err === 'object') {
                        if (!err.message.toLowerCase().includes('index is out of range')) {
                            log.debug(err);
                            return reject(new Error(err));
                        }
                    }

                    counter += 1;
                    return resolve(wsm._fusionSendTx(threshold, counter).then((resp) => {
                        return resp;
                    }));
                });

            });
        });
    };

    public optimizeWallet() {
        let wsm = this;
        log.debug('running optimizeWallet');
        return new Promise((resolve, reject) => {
            wsm.fusionTxHash = [];
            wsm._fusionGetMinThreshold().then((res: any) => {
                if (res <= 0) {
                    wsm.notifyUpdate({
                        type: 'fusionTxCompleted',
                        data: INFO_FUSION_SKIPPED,
                        code: 0
                    });
                    log.debug('fusion skipped');
                    log.debug(wsm.fusionTxHash);
                    return resolve(INFO_FUSION_SKIPPED);
                }

                log.debug(`performing fusion tx, threshold: ${res}`);

                return resolve(
                    wsm._fusionSendTx(res).then(() => {
                        wsm.notifyUpdate({
                            type: 'fusionTxCompleted',
                            data: INFO_FUSION_DONE,
                            code: 1
                        });
                        log.debug('fusion done');
                        log.debug(wsm.fusionTxHash);
                        return INFO_FUSION_DONE;
                    }).catch((err) => {
                        let msg = err.message.toLowerCase();
                        let outMsg = ERROR_FUSION_FAILED;
                        switch (msg) {
                            case 'index is out of range':
                                outMsg = wsm.fusionTxHash.length >= 1 ? INFO_FUSION_DONE : INFO_FUSION_SKIPPED;
                                break;
                            default:
                                break;
                        }
                        log.debug(`fusionTx outMsg: ${outMsg}`);
                        log.debug(wsm.fusionTxHash);
                        wsm.notifyUpdate({
                            type: 'fusionTxCompleted',
                            data: outMsg,
                            code: outMsg === INFO_FUSION_SKIPPED ? 0 : 1
                        });
                        return outMsg;
                    })
                );
            }).catch((err) => {
                // todo handle this differently!
                log.debug('fusion error');
                return reject((err.message));
            });
        });
    };

    public networkStateUpdate(state) {
        if (!this.syncWorker) return;
        log.debug('ServiceProcess PID: ' + this.servicePid);
        if (state === 0) {
            // pause the syncworker, but leave service running
            this.syncWorker.send({
                type: 'pause',
                data: null
            });
        } else {
            this.init();
            // looks like turtle-service always stalled after disconnected, just kill & relaunch it
            let pid = this.serviceProcess.pid || null;
            this.terminateService();
            // remove config
            this._wipeConfig();
            // wait a bit
            setImmediate(() => {
                if (pid) {
                    try { process.kill(pid, 'SIGKILL'); } catch (e) { }
                    // remove config
                    this._wipeConfig();
                }
                setTimeout(() => {
                    log.debug(`respawning ${config.walletServiceBinaryFilename}`);
                    this.serviceProcess = childProcess.spawn(this.serviceBin, this.serviceActiveArgs);
                    // store new pid
                    this.servicePid = this.serviceProcess.pid;
                    this.syncWorker.send({
                        type: 'resume',
                        data: null
                    });
                }, 15000);
            }, 2500);
        }
    };

    public notifyUpdate(msg) {
        uiupdater.updateUiState(msg);
    };

    public resetState() {
        return this._reinitSession();
    };

};