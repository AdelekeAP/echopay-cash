"""POST /transfer/sync-offline-batch — replay queued offline transfers.

PRD §15.7 / PRD_FUNBI §13. The mobile outbox sends pending offline ops
in batches; each is passed through the in-network handler with
`from_locked=True` so the debit comes out of the sender's pre-allocated
offline budget (`wallets.locked_kobo`).

Idempotency_key UNIQUE on `transactions` ensures replays don't double
spend. Each row returns an independent ack/reject result so partial
failures don't block the rest of the batch.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core.db import get_db
from .transfer import (
    InNetworkTransferRequest,
    in_network_transfer,
)

router = APIRouter(prefix="/transfer", tags=["sync"])

MAX_BATCH = 50


class _BatchOp(BaseModel):
    idempotency_key: str = Field(..., min_length=1, max_length=128)
    from_user_id: int = Field(..., ge=1)
    to_user_id: int = Field(..., ge=1)
    amount_kobo: int = Field(..., gt=0)


class SyncBatchRequest(BaseModel):
    ops: List[_BatchOp] = Field(..., min_length=1, max_length=MAX_BATCH)


class _ResultRow(BaseModel):
    idempotency_key: str
    status: str                   # 'acked' | 'rejected'
    tx_id: str | None = None
    error: dict | None = None


class SyncBatchResponse(BaseModel):
    success: bool
    data: "_BatchData"


class _BatchData(BaseModel):
    results: List[_ResultRow]


SyncBatchResponse.model_rebuild()


@router.post("/sync-offline-batch", response_model=SyncBatchResponse)
def sync_offline_batch(
    req: SyncBatchRequest, db: Session = Depends(get_db)
) -> SyncBatchResponse:
    results: list[_ResultRow] = []
    for op in req.ops:
        inner = InNetworkTransferRequest(
            from_user_id=op.from_user_id,
            to_user_id=op.to_user_id,
            amount_kobo=op.amount_kobo,
            idempotency_key=op.idempotency_key,
            from_locked=True,                                  # offline replay
        )
        try:
            tx = in_network_transfer(inner, db)
            results.append(
                _ResultRow(
                    idempotency_key=op.idempotency_key,
                    status="acked",
                    tx_id=tx.data.tx_id,
                )
            )
        except HTTPException as e:
            results.append(
                _ResultRow(
                    idempotency_key=op.idempotency_key,
                    status="rejected",
                    error=(
                        e.detail
                        if isinstance(e.detail, dict)
                        else {"code": "rejected", "message": str(e.detail)}
                    ),
                )
            )

    return SyncBatchResponse(success=True, data=_BatchData(results=results))
