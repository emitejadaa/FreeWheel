import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class PaymentsService {
  createPaymentIntent(): never {
    throw new NotImplementedException(
      'Real payment providers are not integrated yet',
    );
  }

  markAsPaid(): never {
    throw new NotImplementedException('Payment capture is not implemented yet');
  }

  refund(): never {
    throw new NotImplementedException('Refunds are not implemented yet');
  }

  release(): never {
    throw new NotImplementedException('Fund release is not implemented yet');
  }
}
