import { webFrame, remote } from 'electron';
import Store from 'electron-store';
import { Utils } from './ws_utils';
import { WalletShellSession } from './ws_session';
import { config } from './ws_config';
import { syncStatus } from './ws_constants';
import * as log from 'electron-log';

import { walletSession } from './wsui_main'

const wsutil = new Utils();
const brwin: any = remote.getCurrentWindow();
const settings = new Store({ name: 'Settings' });
const sessConfig = { debug: (remote as any).app.debug, walletConfig: (remote as any).app.walletConfig };

const wsession = new WalletShellSession(sessConfig);

/* sync progress ui */
const syncDiv: any = document.getElementById('navbar-div-sync');
const syncInfoBar: any = document.getElementById('navbar-text-sync');
const connInfoDiv: any = document.getElementById('conn-info');
const WFCLEAR_INTERVAL: number = 5;

let WFCLEAR_TICK: number = 0;
let FUSION_CHECK: number = 0;
let TX_INITIALIZED: boolean = false;

export class UpdateUiState {

    public setWinTitle(title?: string) {
        const defaultTitle = wsession.get('defaultTitle');
        brwin.setTitle((title ? `${defaultTitle} ${title}` : defaultTitle));
    }

    public triggerTxRefresh() {
        const txUpdateInputFlag: any = document.getElementById('transaction-updated');
        txUpdateInputFlag.value = 1;
        txUpdateInputFlag.dispatchEvent(new Event('change'));
    }

    public updateSyncProgress(data) {
        const iconSync = document.getElementById('navbar-icon-sync');
        let blockCount = data.displayBlockCount;
        let knownBlockCount = data.displayKnownBlockCount;
        let blockSyncPercent = data.syncPercent;
        let statusText = '';

        switch (knownBlockCount) {
            case syncStatus.NET_ONLINE:
                // sync status text
                statusText = 'RESUMING WALLET SYNC...';
                syncInfoBar.innerHTML = statusText;
                // sync info bar class
                syncDiv.className = 'syncing';
                // sync status icon
                iconSync.setAttribute('data-icon', 'sync');
                iconSync.classList.add('fa-spin');
                // connection status
                connInfoDiv.innerHTML = 'Connection restored, resuming sync process...';
                connInfoDiv.classList.remove('empty');
                connInfoDiv.classList.remove('conn-warning');

                // sync sess flags
                wsession.set('syncStarted', false);
                wsession.set('synchronized', false);
                brwin.setProgressBar(-1);
                break;
            case syncStatus.NET_OFFLINE:
                // sync status text
                statusText = 'PAUSED, NETWORK DISCONNECTED';
                syncInfoBar.innerHTML = statusText;
                // sync info bar class
                syncDiv.className = '';
                // sync status icon
                iconSync.setAttribute('data-icon', 'ban');
                iconSync.classList.remove('fa-spin');
                // connection status
                connInfoDiv.innerHTML = 'Synchronization paused, please check your network connection!';
                connInfoDiv.classList.remove('empty');
                connInfoDiv.classList.add('conn-warning');

                // sync sess flags
                wsession.set('syncStarted', false);
                wsession.set('synchronized', false);
                brwin.setProgressBar(-1);
                // reset balance
                let resetBalance = {
                    availableBalance: 0,
                    lockedAmount: 0
                };
                this.updateBalance(resetBalance);
                break;
            case syncStatus.IDLE:
                // sync status text
                statusText = 'IDLE';
                syncInfoBar.innerHTML = statusText;
                // sync info bar class
                syncDiv.className = '';
                // sync status icon
                iconSync.setAttribute('data-icon', 'pause-circle');
                iconSync.classList.remove('fa-spin');
                // connection status
                connInfoDiv.classList.remove('conn-warning');
                connInfoDiv.classList.add('empty');
                connInfoDiv.textContent = '';

                // sync sess flags
                wsession.set('syncStarted', false);
                wsession.set('synchronized', false);
                brwin.setProgressBar(-1);
                // reset wintitle
                this.setWinTitle();
                // no node connected
                wsession.set('connectedNode', '');
                break;
            case syncStatus.RESET:
                if (!connInfoDiv.innerHTML.startsWith('Connected')) {
                    let connStatusText = `Connected to: <strong>${wsession.get('connectedNode')}</strong>`;
                    let connNodeFee = wsession.get('nodeFee');
                    if (connNodeFee > 0) {
                        connStatusText += ` | Node fee: <strong>${connNodeFee.toFixed(config.decimalPlaces)} ${config.assetTicker}</strong>`;
                    }
                    connInfoDiv.innerHTML = connStatusText;
                    connInfoDiv.classList.remove('conn-warning');
                    connInfoDiv.classList.remove('empty');
                }
                wsession.set('syncStarted', true);
                statusText = 'PREPARING RESCAN...';
                // info bar class
                syncDiv.className = 'syncing';
                syncInfoBar.textContent = statusText;
                // status icon
                iconSync.setAttribute('data-icon', 'sync');
                iconSync.classList.add('fa-spin');
                // sync status sess flag
                wsession.set('synchronized', false);
                brwin.setProgressBar(-1);
                break;
            case syncStatus.NODE_ERROR:
                // status info bar class
                syncDiv.className = 'failed';
                // sync status text
                statusText = 'NODE ERROR';
                syncInfoBar.textContent = statusText;
                //sync status icon
                iconSync.setAttribute('data-icon', 'times');
                iconSync.classList.remove('fa-spin');
                // connection status
                connInfoDiv.innerHTML = 'Connection failed, try switching to another Node, close and reopen your wallet';
                connInfoDiv.classList.remove('empty');
                connInfoDiv.classList.add('conn-warning');
                wsession.set('connectedNode', '');
                brwin.setProgressBar(-1);
                break;
            default:
                if (!connInfoDiv.innerHTML.startsWith('Connected')) {
                    let connStatusText = `Connected to: <strong>${wsession.get('connectedNode')}</strong>`;
                    let connNodeFee = wsession.get('nodeFee');
                    if (connNodeFee > 0) {
                        connStatusText += ` | Node fee: <strong>${connNodeFee.toFixed(config.decimalPlaces)} ${config.assetTicker}</strong>`;
                    }
                    connInfoDiv.innerHTML = connStatusText;
                    connInfoDiv.classList.remove('conn-warning');
                    connInfoDiv.classList.remove('empty');
                }
                // sync sess flags
                wsession.set('syncStarted', true);
                statusText = `${blockCount}/${knownBlockCount}`;
                if (blockCount + 1 >= knownBlockCount && knownBlockCount !== 0) {
                    // info bar class
                    syncDiv.classList = 'synced';
                    // status text
                    statusText = `SYNCED ${statusText}`;
                    syncInfoBar.textContent = statusText;
                    // status icon
                    iconSync.setAttribute('data-icon', 'check');
                    iconSync.classList.remove('fa-spin');
                    // sync status sess flag
                    wsession.set('synchronized', true);
                    brwin.setProgressBar(-1);
                } else {
                    // info bar class
                    syncDiv.className = 'syncing';
                    // status text
                    statusText = `SYNCING ${statusText}`;
                    if (blockSyncPercent < 100) statusText += ` (${blockSyncPercent}%)`;
                    syncInfoBar.textContent = statusText;
                    // status icon
                    iconSync.setAttribute('data-icon', 'sync');
                    iconSync.classList.add('fa-spin');
                    // sync status sess flag
                    wsession.set('synchronized', false);
                    let taskbarProgress = +(parseFloat(blockSyncPercent) / 100).toFixed(2);
                    brwin.setProgressBar(taskbarProgress);
                }
                break;
        }

        if (WFCLEAR_TICK === WFCLEAR_INTERVAL) {
            webFrame.clearCache();
            WFCLEAR_TICK = 0;
        }
        WFCLEAR_TICK++;

        // handle failed fusion
        if (true === wsession.get('fusionProgress')) {
            let lockedBalance = wsession.get('walletLockedBalance');
            if (lockedBalance <= 0 && FUSION_CHECK === 3) {
                this.fusionCompleted();
            }
            FUSION_CHECK++;
        }
    }

    public fusionCompleted() {
        const fusionProgressBar = document.getElementById('fusionProgress');
        fusionProgressBar.classList.add('hidden');
        FUSION_CHECK = 0;
        wsession.set('fusionStarted', false);
        wsession.set('fusionProgress', false);
        wsutil.showToast('Optimization completed. You may need to repeat the process until your wallet is fully optimized.', 5000);
    }

    private formatLikeCurrency(x) {
        return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    public updateBalance(data) {
        const balanceAvailableField = document.querySelector('#balance-available > span');
        const balanceLockedField = document.querySelector('#balance-locked > span');
        const maxSendFormHelp = document.getElementById('sendFormHelp');
        const sendMaxAmount = document.getElementById('sendMaxAmount');
        let inputSendAmountField = document.getElementById('input-send-amount');

        if (!data) return;
        let availableBalance = parseFloat(data.availableBalance) || 0;

        let bUnlocked = this.formatLikeCurrency(wsutil.amountForMortal(availableBalance));
        let bLocked = this.formatLikeCurrency(wsutil.amountForMortal(data.lockedAmount));
        let fees = (wsession.get('nodeFee') + config.minimumFee).toFixed(config.decimalPlaces);
        let maxSendRaw = (bUnlocked - fees);

        if (maxSendRaw <= 0) {
            // inputSendAmountField.value = 0;
            inputSendAmountField.setAttribute('max', '0.00');
            inputSendAmountField.setAttribute('disabled', 'disabled');
            maxSendFormHelp.innerHTML = "You don't have any funds to be sent.";
            sendMaxAmount.dataset.maxsend = '0';
            sendMaxAmount.classList.add('hidden');
            wsession.set('walletUnlockedBalance', 0);
            wsession.set('walletLockedBalance', 0);
            if (availableBalance < 0) return;
        }

        balanceAvailableField.innerHTML = bUnlocked;
        balanceLockedField.innerHTML = bLocked;
        wsession.set('walletUnlockedBalance', bUnlocked);
        wsession.set('walletLockedBalance', bLocked);
        // update fusion progress
        if (true === wsession.get('fusionProgress')) {
            if (wsession.get('fusionStarted') && parseInt(bLocked, 10) <= 0) {
                this.fusionCompleted();
            } else {
                if (parseInt(bLocked, 10) > 0) {
                    wsession.set('fusionStarted', true);
                }
            }
        }

        let walletFile = require('path').basename(settings.get('recentWallet'));
        let wintitle = `(${walletFile}) - ${bUnlocked} ${config.assetTicker}`;
        this.setWinTitle(wintitle);

        if (maxSendRaw > 0) {
            let maxSend = (maxSendRaw).toFixed(config.decimalPlaces);
            inputSendAmountField.setAttribute('max', maxSend);
            inputSendAmountField.removeAttribute('disabled');
            maxSendFormHelp.innerHTML = `Max. amount is ${maxSend}`;
            sendMaxAmount.dataset.maxsend = maxSend;
            sendMaxAmount.classList.remove('hidden');
        }
    }

    public updateTransactions(result) {
        let txlistExisting = wsession.get('txList');
        const blockItems = result.items;

        if (!txlistExisting.length && !blockItems.length) {
            document.getElementById('transaction-export').classList.add('hidden');
        } else {
            document.getElementById('transaction-export').classList.remove('hidden');
        }

        if (!blockItems.length) return;

        let txListNew = [];

        Array.from(blockItems).forEach((block: any) => {
            block.transactions.map((tx) => {
                if (tx.amount !== 0 && !wsutil.objInArray(txlistExisting, tx, 'transactionHash')) {
                    tx.amount = wsutil.amountForMortal(tx.amount);
                    tx.prettyAmount = wsutil.amountForMortal(tx.amount);
                    tx.timeStr = new Date(tx.timestamp * 1000).toUTCString();
                    tx.fee = wsutil.amountForMortal(tx.fee);
                    tx.paymentId = tx.paymentId.length ? tx.paymentId : '-';
                    tx.txType = (tx.amount > 0 ? 'in' : 'out');
                    tx.rawAmount = parseInt(tx.amount);
                    tx.rawFee = tx.fee;
                    tx.rawPaymentId = tx.paymentId;
                    tx.rawHash = tx.transactionHash;
                    txListNew.unshift(tx);
                }
            });
        });

        if (!txListNew.length) return;
        let latestTx = txListNew[0];
        let newLastHash = latestTx.transactionHash;
        let newLastTimestamp = latestTx.timestamp;
        let newTxAmount = latestTx.amount;

        // store it
        wsession.set('txLastHash', newLastHash);
        wsession.set('txLastTimestamp', newLastTimestamp);
        let txList = txListNew.concat(txlistExisting);
        wsession.set('txList', txList);
        wsession.set('txLen', txList.length);
        wsession.set('txNew', txListNew);

        let rawCurrentDate: Date = new Date();
        let currentDate: string = `${rawCurrentDate.getUTCFullYear()}-${rawCurrentDate.getUTCMonth() + 1}-${rawCurrentDate.getUTCDate()}`;
        let rawLastTxDate = new Date(newLastTimestamp * 1000);
        let lastTxDate = `${rawLastTxDate.getUTCFullYear()}-${rawLastTxDate.getUTCMonth() + 1}-${rawLastTxDate.getUTCDate()}`;

        // amount to check
        setTimeout(this.triggerTxRefresh, (TX_INITIALIZED ? 100 : 1000));

        let rememberedLastHash = settings.get('last_notification', '');
        let notify = true;
        if (lastTxDate !== currentDate || (newTxAmount < 0) || rememberedLastHash === newLastHash) {
            notify = false;
        }

        if (notify) {
            settings.set('last_notification', newLastHash);
            let notiOptions = {
                'body': `Amount: ${(newTxAmount)} ${config.assetTicker}\nHash: ${newLastHash.substring(24, -0)}...`,
                'icon': '../assets/walletshell_icon.png'
            };
            let itNotification = new Notification('Incoming Transfer', notiOptions);
            itNotification.onclick = (event) => {
                event.preventDefault();
                let txNotifyFiled: any = document.getElementById('transaction-notify');
                txNotifyFiled.value = 1;
                txNotifyFiled.dispatchEvent(new Event('change'));
                if (!brwin.isVisible()) brwin.show();
                if (brwin.isMinimized()) brwin.restore();
                if (!brwin.isFocused()) brwin.focus();
            };
        }
    }

    public showFeeWarning(fee) {
        fee = fee || 0;
        let nodeFee = parseFloat(fee);
        if (nodeFee <= 0) return;

        let dialog: any = document.getElementById('main-dialog');
        if (dialog.hasAttribute('open')) return;
        dialog.classList.add('dialog-warning');
        let htmlStr = `
            <h5>Fee Info</h5>
            <p>You are connected to a public node that charges a fee to send transactions.<p>
            <p>The fee for sending transactions is: <strong>${fee.toFixed(config.decimalPlaces)} ${config.assetTicker} </strong>.<br>
                If you don't want to pay the node fee, please close your wallet, reopen and choose different public node (or run your own node).
            </p>
            <p style="text-align:center;margin-top: 1.25rem;"><button  type="button" class="form-bt button-green dialog-close-default" id="dialog-end">OK, I Understand</button></p>
        `;
        dialog.innerHTML = htmlStr;
        dialog.showModal();
        dialog.addEventListener('close', function () {
            dialog.classList.remove('dialog-warning');
            wsutil.clearChild(dialog);
        });
    }

    public updateQr(address) {
        //let backupReminder = document.getElementById('button-overview-showkeys');
        if (!address) {
            this.triggerTxRefresh();
        }

        let walletHash = wsutil.fnvhash(address);
        wsession.set('walletHash', walletHash);

        let oldImg = document.getElementById('qr-gen-img');
        if (oldImg) oldImg.remove();

        let qr_base64 = wsutil.genQrDataUrl(address);
        if (qr_base64.length) {
            let qrBox = document.getElementById('div-w-qr');
            let qrImg = document.createElement("img");
            qrImg.setAttribute('id', 'qr-gen-img');
            qrImg.setAttribute('src', qr_base64);
            qrBox.prepend(qrImg);
            document.getElementById('scan-qr-help').classList.remove('hidden');
        } else {
            document.getElementById('scan-qr-help').classList.add('hidden');
        }
    }

    public resetFormState() {
        const allFormInputs = document.querySelectorAll('.section input,.section textarea');
        if (!allFormInputs) return;

        for (var i = 0; i < allFormInputs.length; i++) {
            let el: any = allFormInputs[i];
            if (el.dataset.initial) {
                if (!el.dataset.noclear) {
                    el.value = settings.has(el.dataset.initial) ? settings.get(el.dataset.initial) : '';
                    if (el.getAttribute('type') === 'checkbox') {
                        el.checked = settings.get(el.dataset.initial);
                    }
                }
            } else if (el.dataset.default) {
                if (!el.dataset.noclear) {
                    el.value = el.dataset.default;
                }
            } else {
                if (!el.dataset.noclear) el.value = '';
            }
        }

        const settingsBackBtn = document.getElementById('button-settings-back');
        if (wsession.get('serviceReady')) {
            connInfoDiv.classList.remove('empty');
            settingsBackBtn.dataset.section = 'section-welcome';
        } else {
            connInfoDiv.classList.add('empty');
            settingsBackBtn.dataset.section = 'section-overview';
        }
    }

    // update ui state, push from svc_main
    public updateUiState(msg: any) {
        // do something with msg
        switch (msg.type) {
            case 'blockUpdated':
                this.updateSyncProgress(msg.data);
                break;
            case 'balanceUpdated':
                this.updateBalance(msg.data);
                break;
            case 'transactionUpdated':
                this.updateTransactions(msg.data);
                break;
            case 'nodeFeeUpdated':
                this.showFeeWarning(msg.data);
                break;
            case 'addressUpdated':
                this.updateQr(msg.data);
                break;
            case 'sectionChanged':
                if (msg.data) this.resetFormState();
                break;
            case 'fusionTxCompleted':
                const fusionProgressBar = document.getElementById('fusionProgress');
                if (msg.code === 0) { // skipped
                    wsession.set('fusionProgress', false);
                    fusionProgressBar.classList.add('hidden');
                    wsutil.showToast(msg.data, 5000);
                } else {
                    // set progress flag
                    wsession.set('fusionProgress', true);
                    // show progress bar
                    fusionProgressBar.classList.remove('hidden');
                    // do nothing, just wait
                }
                break;
            default:
                console.log('invalid command', msg);
                break;
        }
    }
}