import '../signing_backend.dart';
import 'nft_mint_job.dart';

abstract interface class TbcNftMintJobBackend {
  Future<TbcNftMintJobOwner> beginNftMintJob(
    TbcSigningRequestScope scope,
    NftJobMap consent,
  );
}

abstract interface class TbcNftMintJobOwner {
  Future<TbcSigningOperation> beginBatch(
    TbcSigningRequestScope scope,
    NftJobMap request,
    int offset,
  );
  Future<NftJobMap> batchResult();
  Future<NftJobMap> finish(String reason);
  Future<void> close();
}
