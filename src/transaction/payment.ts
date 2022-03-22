import * as _ from 'lodash'
import * as utils from './utils'
const validate = utils.common.validate
const toDivvydAmount = utils.common.toDivvydAmount
const paymentFlags = utils.common.txFlags.Payment
const ValidationError = utils.common.errors.ValidationError
import {Instructions, Prepare} from './types'
import {Amount, Adjustment, MaxAdjustment,
  MinAdjustment, Memo} from '../common/types/objects'


  export type Payment = {
  source: Adjustment & MaxAdjustment,
  destination: Adjustment & MinAdjustment,
  paths?: string,
  memos?: Array<Memo>,
  // A 256-bit hash that can be used to identify a particular payment
  invoiceID?: string,
  // A boolean that, if set to true, indicates that this payment should go
  // through even if the whole amount cannot be delivered because of a lack of
  // liquidity or funds in the source_account account
  allowPartialPayment?: boolean,
  // A boolean that can be set to true if paths are specified and the sender
  // would like the Divvy Network to disregard any direct paths from
  // the source_account to the destination_account. This may be used to take
  // advantage of an arbitrage opportunity or by gateways wishing to issue
  // balances from a hot wallet to a user who has mistakenly set a trustline
  // directly to the hot wallet
  noDirectDivvy?: boolean,
  limitQuality?: boolean
}

function isXDVToXDVPayment(payment: Payment): boolean {
  const sourceCurrency = _.get(payment, 'source.maxAmount.currency',
    _.get(payment, 'source.amount.currency'))
  const destinationCurrency = _.get(payment, 'destination.amount.currency',
    _.get(payment, 'destination.minAmount.currency'))
  return sourceCurrency === 'XDV' && destinationCurrency === 'XDV'
}

function isIOUWithoutCounterparty(amount: Amount): boolean {
  return amount && amount.currency !== 'XDV'
    && amount.counterparty === undefined
}

function applyAnyCounterpartyEncoding(payment: Payment): void {
  // Convert blank counterparty to sender or receiver's address
  //   (Divvy convention for 'any counterparty')
  // https://divvy.com/build/transactions/
  //    #special-issuer-values-for-sendmax-and-amount
  // https://divvy.com/build/divvy-rest/#counterparties-in-payments
  _.forEach([payment.source, payment.destination], adjustment => {
    _.forEach(['amount', 'minAmount', 'maxAmount'], key => {
      if (isIOUWithoutCounterparty(adjustment[key])) {
        adjustment[key].counterparty = adjustment.address
      }
    })
  })
}

function createMaximalAmount(amount: Amount): Amount {
  const maxXDVValue = '100000000000'
  const maxIOUValue = '9999999999999999e80'
  const maxValue = amount.currency === 'XDV' ? maxXDVValue : maxIOUValue
  return _.assign({}, amount, {value: maxValue})
}

function createPaymentTransaction(address: string, paymentArgument: Payment
): Object {
  const payment = _.cloneDeep(paymentArgument)
  applyAnyCounterpartyEncoding(payment)

  if (address !== payment.source.address) {
    throw new ValidationError('address must match payment.source.address')
  }

  if ((payment.source.maxAmount && payment.destination.minAmount) ||
      (payment.source.amount && payment.destination.amount)) {
    throw new ValidationError('payment must specify either (source.maxAmount '
      + 'and destination.amount) or (source.amount and destination.minAmount)')
  }

  // when using destination.minAmount, divvyd still requires that we set
  // a destination amount in addition to DeliverMin. the destination amount
  // is interpreted as the maximum amount to send. we want to be sure to
  // send the whole source amount, so we set the destination amount to the
  // maximum possible amount. otherwise it's possible that the destination
  // cap could be hit before the source cap.
  const amount = payment.destination.minAmount && !isXDVToXDVPayment(payment) ?
    createMaximalAmount(payment.destination.minAmount) :
    (payment.destination.amount || payment.destination.minAmount)

  const txJSON: any = {
    TransactionType: 'Payment',
    Account: payment.source.address,
    Destination: payment.destination.address,
    Amount: toDivvydAmount(amount),
    Flags: 0
  }

  if (payment.invoiceID !== undefined) {
    txJSON.InvoiceID = payment.invoiceID
  }
  if (payment.source.tag !== undefined) {
    txJSON.SourceTag = payment.source.tag
  }
  if (payment.destination.tag !== undefined) {
    txJSON.DestinationTag = payment.destination.tag
  }
  if (payment.memos !== undefined) {
    txJSON.Memos = _.map(payment.memos, utils.convertMemo)
  }
  if (payment.noDirectDivvy === true) {
    txJSON.Flags |= paymentFlags.NoDivvyDirect
  }
  if (payment.limitQuality === true) {
    txJSON.Flags |= paymentFlags.LimitQuality
  }
  if (!isXDVToXDVPayment(payment)) {
    // Don't set SendMax for XDV->XDV payment
    // temREDUNDANT_SEND_MAX removed in:
    // https://github.com/divvy/divvyd/commit/
    //  c522ffa6db2648f1d8a987843e7feabf1a0b7de8/
    if (payment.allowPartialPayment === true
        || payment.destination.minAmount !== undefined) {
      txJSON.Flags |= paymentFlags.PartialPayment
    }

    txJSON.SendMax = toDivvydAmount(
      payment.source.maxAmount || payment.source.amount)

    if (payment.destination.minAmount !== undefined) {
      txJSON.DeliverMin = toDivvydAmount(payment.destination.minAmount)
    }

    if (payment.paths !== undefined) {
      txJSON.Paths = JSON.parse(payment.paths)
    }
  } else if (payment.allowPartialPayment === true) {
    throw new ValidationError('XDV to XDV payments cannot be partial payments')
  }

  return txJSON
}

function preparePayment(address: string, payment: Payment,
  instructions: Instructions = {}
): Promise<Prepare> {
  validate.preparePayment({address, payment, instructions})
  const txJSON = createPaymentTransaction(address, payment)
  return utils.prepareTransaction(txJSON, this, instructions)
}

export default preparePayment
