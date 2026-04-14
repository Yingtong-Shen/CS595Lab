use dep::merkle_trees::compute_merkle_root;
use dep::std::hash::pedersen_hash;
global N: u32 = 8;
fn main(
    r: Field,
    index: Field,
    hashpath: [Field; N],
    root: pub Field,
    id: pub Field
) {
    let commitment: Field = pedersen_hash([id, r]);
    assert(compute_merkle_root(commitment, index, hashpath) == root);
}